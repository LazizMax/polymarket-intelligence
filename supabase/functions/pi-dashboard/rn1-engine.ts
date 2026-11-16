const SQL = "WITH rr AS (\n SELECT id,received_at,position_observed_at,positions,quotes\n FROM pi.rn1_quote_probe_runs\n WHERE position_status='complete' AND position_observed_at IS NOT NULL\n   AND position_observed_at<=received_at\n ORDER BY received_at DESC,id DESC LIMIT 1400\n),\nq AS (\n SELECT r.id run_id,r.received_at,\n  x->>'market_key' market_key,x->>'asset_id' token_id,\n  x->>'event_slug' event_slug,x->>'origin' origin,\n  (x->>'mid')::float8 mid,(x->>'spread')::float8 spread,\n  (x->>'bid_size')::float8 bid_size,(x->>'ask_size')::float8 ask_size,\n  to_timestamp((x->>'book_at')::float8/1000) book_at\n FROM rr r CROSS JOIN LATERAL jsonb_array_elements(r.quotes) x\n WHERE x->>'book_valid'='true'\n   AND x->>'mid' IS NOT NULL AND x->>'bid_size' IS NOT NULL AND x->>'ask_size' IS NOT NULL\n   AND x->>'spread' IS NOT NULL AND x->>'book_at' IS NOT NULL\n),\np AS (\n SELECT r.id run_id,x->>'market_key' market_key,x->>'token_id' token_id,\n  (x->>'current_size')::float8 shares,\n  coalesce((x->>'entry_cost_usdc')::float8,0) cost,\n  (x->>'returned_by_api')::boolean returned\n FROM rr r CROSS JOIN LATERAL jsonb_array_elements(r.positions) x\n WHERE x->>'current_size' IS NOT NULL AND x->>'returned_by_api' IS NOT NULL\n),\neligible AS (\n SELECT q.*, own.shares own_shares,other.shares other_shares,\n   own.cost+other.cost market_cost\n FROM q JOIN p own ON own.run_id=q.run_id AND own.market_key=q.market_key AND own.token_id=q.token_id\n JOIN p other ON other.run_id=q.run_id AND other.market_key=q.market_key AND other.token_id<>q.token_id\n WHERE own.returned AND other.returned AND q.book_at<=q.received_at\n   AND q.mid BETWEEN 0.005 AND 0.995\n   AND q.spread>=0 AND q.spread<=0.5\n   AND q.bid_size>=0 AND q.ask_size>=0\n   AND q.event_slug IS NOT NULL\n),\ntime_features AS (\n SELECT *,\n lag(mid) over(partition by market_key,token_id order by received_at,run_id) prev_mid,\n lag(received_at) over(partition by market_key,token_id order by received_at,run_id) prev_received\n FROM eligible\n)\nSELECT event_slug,market_key,token_id,origin,\n extract(epoch from received_at)::float8 observed_epoch,\n mid,spread,bid_size,ask_size,own_shares,other_shares,market_cost,\n extract(epoch from (received_at-book_at))::float8 book_age_seconds,\n CASE WHEN prev_received IS NOT NULL AND received_at-prev_received<=interval '180 seconds'\n  THEN mid-prev_mid ELSE 0 END quote_momentum,\n CASE WHEN EXISTS(\n SELECT 1 FROM pi.rn1_quote_probe_fills f\n WHERE f.market_key=t.market_key AND f.token_id=t.token_id\n   AND f.role='maker_inferred' AND f.side='BUY'\n   AND f.trade_at>t.received_at AND f.trade_at<=t.received_at+interval '60 seconds'\n ) THEN 1 ELSE 0 END observed_next_fill\nFROM time_features t\nORDER BY observed_epoch,market_key,token_id";
// RN1 black-box identification. Read-only, public fills and public books only.
// This is a model of OBSERVED future matched maker fills, not private order submission.
// All features precede the outcome window. Event-scoped cross-validation prevents
// same-event market leakage. No external odds/oracle is present in these features.
type Raw = Record<string, unknown>;
type Datum = {event:string;market:string;token:string;origin:string;time:number;mid:number;
 spread:number;own:number;opp:number;cost:number;x:number[];y:number};
type Model = {id:string;label:string;columns:number[]};
const MODELS: Model[] = [
 {id:"base",label:"Taux constant",columns:[]},
 {id:"selection",label:"Univers suivi / témoin",columns:[0]},
 {id:"micro",label:"Carnet et variations Polymarket",columns:[0,1,2,3,4,5,6,7]},
 {id:"inventory",label:"Carnet + inventaire YES/NO",columns:[0,1,2,3,4,5,6,7,8,9,10,11]}
];
function num(v:unknown):number{const n=Number(v);return Number.isFinite(n)?n:0;}
function sigmoid(z:number):number{const a=Math.max(-25,Math.min(25,z));return 1/(1+Math.exp(-a));}
function hashEvent(s:string):number{let h=2166136261>>>0;for(let i=0;i<s.length;i++){h=Math.imul(h^s.charCodeAt(i),16777619)>>>0;}return h>>>0;}
function features(r:Raw):number[]{
 const bid=Math.max(0,num(r.bid_size)),ask=Math.max(0,num(r.ask_size));
 const own=Math.max(0,num(r.own_shares)),opp=Math.max(0,num(r.other_shares));
 const cost=Math.max(0,num(r.market_cost));
 return [
  r.origin==="rn1_recent"?1:0,
  2*(num(r.mid)-0.5),
  Math.log1p(Math.max(0,num(r.spread))/0.01),
  Math.log1p(bid),
  Math.log1p(ask),
  (bid-ask)/(bid+ask+1),
  20*num(r.quote_momentum),
  Math.max(0,Math.min(2,num(r.book_age_seconds)/60)),
  Math.log1p(cost),
  (own-opp)/(own+opp+1),
  Math.log1p(own),
  Math.log1p(opp)
 ];
}
function fit(data:Datum[],ids:number[],cols:number[]):(r:Datum)=>number{
 const n=ids.length,positive=ids.reduce((a,i)=>a+data[i].y,0);
 const prior=Math.max(0.001,Math.min(0.999,(positive+0.5)/(n+1)));
 const mu=cols.map(c=>ids.reduce((a,i)=>a+data[i].x[c],0)/Math.max(1,n));
 const sd=cols.map((c,j)=>Math.max(0.01,Math.sqrt(ids.reduce((a,i)=>a+(data[i].x[c]-mu[j])**2,0)/Math.max(1,n))));
 const d=cols.length,w=new Array(d+1).fill(0);w[0]=Math.log(prior/(1-prior));
 // Fixed L2 and iterations; not selected by examining held-out events.
 if(n>=10) for(let step=0;step<240;step++){
  const g=new Array(d+1).fill(0);
  for(const i of ids){
   const row=data[i];let z=w[0];for(let j=0;j<d;j++)z+=w[j+1]*(row.x[cols[j]]-mu[j])/sd[j];
   const e=sigmoid(z)-row.y;g[0]+=e;
   for(let j=0;j<d;j++)g[j+1]+=e*(row.x[cols[j]]-mu[j])/sd[j];
  }
  w[0]-=0.25*g[0]/n;
  for(let j=0;j<d;j++)w[j+1]-=0.25*(g[j+1]/n+0.01*w[j+1]);
 }
 return (r:Datum)=>{
  let z=w[0];for(let j=0;j<d;j++)z+=w[j+1]*(r.x[cols[j]]-mu[j])/sd[j];
  return Math.max(0.00001,Math.min(0.99999,sigmoid(z)));
 };
}
function loss(y:number,p:number){return -(y*Math.log(p)+(1-y)*Math.log(1-p));}
function score(data:Datum[],preds:number[]){
 const n=data.length,pos=data.reduce((a,r)=>a+r.y,0);
 let ll=0,br=0;
 for(let i=0;i<n;i++){ll+=loss(data[i].y,preds[i]);br+=(preds[i]-data[i].y)**2;}
 const sorted=data.map((r,i)=>({y:r.y,p:preds[i]})).sort((a,b)=>b.p-a.p);
 let hits=0,ap=0;for(let i=0;i<sorted.length;i++)if(sorted[i].y){hits++;ap+=hits/(i+1);}
 return {log_loss:ll/Math.max(1,n),brier:br/Math.max(1,n),average_precision:pos?ap/pos:null};
}
function boot(data:Datum[],reference:number[],candidate:number[]){
 const byEvent=new Map<string,number[]>();
 for(let i=0;i<data.length;i++){const key=data[i].event;const a=byEvent.get(key)||[];a.push(i);byEvent.set(key,a);}
 const events=[...byEvent.values()];if(events.length<5)return null;
 // Deterministic event-cluster bootstrap. Positive = improvement in log loss.
 let seed=0x12AB45CD;const draw=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
 const values:number[]=[];
 for(let b=0;b<300;b++){
  let sum=0,n=0;
  for(let k=0;k<events.length;k++){
   const group=events[Math.floor(draw()*events.length)];
   for(const i of group){sum+=loss(data[i].y,reference[i])-loss(data[i].y,candidate[i]);n++;}
  }
  values.push(sum/Math.max(1,n));
 }
 values.sort((a,b)=>a-b);
 return {low:values[Math.floor(.025*(values.length-1))],high:values[Math.floor(.975*(values.length-1))]};
}
export async function rn1EngineForensics(db:any){
 const raw:Raw[]=await db.unsafe(SQL);
 const rows:Datum[]=raw.map(r=>({
  event:String(r.event_slug||""),market:String(r.market_key||""),
  token:String(r.token_id||""),origin:String(r.origin||""),
  time:num(r.observed_epoch),mid:num(r.mid),spread:num(r.spread),
  own:num(r.own_shares),opp:num(r.other_shares),cost:num(r.market_cost),
  x:features(r),y:num(r.observed_next_fill)>0?1:0
 })).filter(r=>r.event && r.market && r.time>0 && r.x.every(Number.isFinite));
 if(rows.length<100)return {status:"insufficient",eligible_windows:rows.length,oracle_status:"no_external_odds"};
 const folds=rows.map(r=>hashEvent(r.event)%5);
 const predictions:Record<string,number[]>={};
 const split:{fold:number;test_windows:number;test_positives:number;test_events:number}[]=[];
 for(const m of MODELS)predictions[m.id]=new Array(rows.length).fill(0);
 for(let fold=0;fold<5;fold++){
  const train:number[]=[],test:number[]=[];
  for(let i=0;i<rows.length;i++)(folds[i]===fold?test:train).push(i);
  split.push({fold,test_windows:test.length,
   test_positives:test.reduce((a,i)=>a+rows[i].y,0),
   test_events:new Set(test.map(i=>rows[i].event)).size});
  if(!train.length || !test.length)continue;
  for(const m of MODELS){
   const predict=fit(rows,train,m.columns);
   for(const i of test)predictions[m.id][i]=predict(rows[i]);
  }
 }
 const scores=MODELS.map(m=>({id:m.id,label:m.label,...score(rows,predictions[m.id]),
  vs_selection_ll_gain:m.id==="base"?null:score(rows,predictions.selection).log_loss-score(rows,predictions[m.id]).log_loss,
  gain_ci_vs_selection:m.id==="base"?null:boot(rows,predictions.selection,predictions[m.id])}));
 const inventoryGain={
  log_loss_gain:score(rows,predictions.micro).log_loss-score(rows,predictions.inventory).log_loss,
  event_bootstrap_ci:boot(rows,predictions.micro,predictions.inventory)
 };
 const bins=[{label:"Issue nettement sous-détenue",min:-1.01,max:-.25},
 {label:"Issue modérément sous-détenue",min:-.25,max:-.05},
 {label:"Inventaire proche de l'équilibre",min:-.05,max:.05},
 {label:"Issue modérément sur-détenue",min:.05,max:.25},
 {label:"Issue nettement sur-détenue",min:.25,max:1.01}];
 const inventory_bands=bins.map(b=>{
  const rr=rows.filter(r=>{const v=(r.own-r.opp)/(r.own+r.opp+1);return v>=b.min&&v<b.max;});
  return {label:b.label,windows:rr.length,observed_fills:rr.reduce((a,r)=>a+r.y,0),
   observed_fill_rate:rr.length?rr.reduce((a,r)=>a+r.y,0)/rr.length:null};
 });
 const worst=rows.map((r,i)=>({i,err:Math.abs(r.y-predictions.inventory[i])}))
  .sort((a,b)=>b.err-a.err);
 const seen=new Set<string>(),counterexamples:any[]=[];
 for(const w of worst){const r=rows[w.i];if(seen.has(r.event))continue;seen.add(r.event);
  counterexamples.push({event_slug:r.event,mid:r.mid,spread:r.spread,
   own_shares:Math.round(r.own),other_shares:Math.round(r.opp),
   observed_fill:r.y,predicted_probability:predictions.inventory[w.i],
   observed_epoch:r.time});
  if(counterexamples.length>=8)break;
 }
 // Within-market/within-snapshot paired outcome experiment: a cleaner test of a
 // simple "always buy the underweight side" rule than unconditional fill counts.
 const grouped=new Map<string,Datum[]>();
 for(const r of rows){
  const key=r.market+"|"+r.time;
  const a=grouped.get(key)||[];a.push(r);grouped.set(key,a);
 }
 let paired=0,any=0,both=0,one=0,imbalanced=0,under=0,over=0;
 const eligible:{event:string;under:number}[]=[];
 for(const group of grouped.values()){
  if(group.length!==2||group[0].token===group[1].token)continue;
  paired++;const [a,b]=group;
  if(a.y||b.y)any++;
  if(a.y&&b.y){both++;continue;}
  if(!a.y&&!b.y)continue;
  one++;
  const imbalance=Math.abs(a.own-b.own)/(a.own+b.own+1);
  if(imbalance<=0.1||a.own===b.own)continue;
  imbalanced++;
  const correct=(a.y===1&&a.own<b.own)||(b.y===1&&b.own<a.own);
  if(correct)under++;else over++;
  eligible.push({event:a.event,under:correct?1:0});
 }
 const byMirrorEvent=new Map<string,{n:number;under:number}>();
 for(const t of eligible){const q=byMirrorEvent.get(t.event)||{n:0,under:0};q.n++;q.under+=t.under;byMirrorEvent.set(t.event,q);}
 const me=[...byMirrorEvent.values()];
 let mirrorCI:null|{low:number;high:number}=null;
 if(me.length>=5){
  let seed=0x5B117B;const sample=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};
  const res:number[]=[];
  for(let k=0;k<300;k++){
   let n=0,u=0;
   for(let j=0;j<me.length;j++){const e=me[Math.floor(sample()*me.length)];n+=e.n;u+=e.under;}
   res.push(u/Math.max(1,n));
  }
  res.sort((a,b)=>a-b);
  mirrorCI={low:res[Math.floor(.025*(res.length-1))],high:res[Math.floor(.975*(res.length-1))]};
 }
 const mirror_test={
  paired_windows:paired,at_least_one_fill:any,both_sides_filled:both,exactly_one_side_filled:one,
  imbalance_threshold:0.1,one_side_and_imbalanced:imbalanced,
  filled_underweight:under,filled_overweight:over,
  underweight_rate:imbalanced?under/imbalanced:null,
  event_bootstrap_ci:mirrorCI,event_count:me.length,
  conclusion:"Ce test porte sur les fills observés, pas sur les limites initialement posées. Une préférence faible ne valide pas une règle d'inventaire."
 };
 const first=Math.min(...rows.map(r=>r.time)),last=Math.max(...rows.map(r=>r.time));
 const seenRecent=rows.filter(r=>r.origin==="rn1_recent"),seenControls=rows.filter(r=>r.origin!=="rn1_recent");
 const group=(d:Datum[])=>({windows:d.length,observed_fills:d.reduce((a,r)=>a+r.y,0)});
 return {
  status:"research_candidate",model_version:"rn1-engine-event-v1",label:"Maker BUY observé dans les 60 secondes suivantes",
  hypothesis:{market_making:"partially_testable",external_oracle:"unidentifiable_no_time_stamped_external_odds",
   hybrid:"unidentifiable_no_time_stamped_external_odds"},
  overview:{eligible_windows:rows.length,observed_fill_windows:rows.reduce((a,r)=>a+r.y,0),
   events:new Set(rows.map(r=>r.event)).size,markets:new Set(rows.map(r=>r.market)).size,
   first_epoch:first,last_epoch:last,source_recent:group(seenRecent),source_controls:group(seenControls)},
  folds:split,scores,inventory_gain:inventoryGain,inventory_bands,mirror_test,counterexamples,
  caveats:[
   "Prévision d'une EXÉCUTION Maker inférée visible, pas du placement/annulation d'un ordre privé.",
   "Fenêtres sans fill étiquetées 'aucun fill rapproché observé' : l'archive des fills live est partielle; certaines négatives sont incertaines.",
   "Les marchés suivis sont principalement sélectionnés à partir de l'activité récente de RN1; le groupe témoin n'est pas une population aléatoire universelle.",
   "Carnets REST espacés d'environ une minute; l'état d'inventaire est public, limité aux marchés sélectionnés et exige les deux issues confirmées par l'API.",
   "5-fold par événement, non prospectif; période de collecte encore courte. Bootstrap regroupé par événement = incertitude conditionnelle aux défauts de mesure.",
   "Les odds indépendantes et historiques nécessaires à M1/M2 ne sont pas connectées; absence de preuve d'oracle n'est pas réfutation.",
   "Scores de probabilité conditionnelle à des marchés/token déjà échantillonnés; pas de backtest d'exécution ni de PnL."
  ]
 };
}
