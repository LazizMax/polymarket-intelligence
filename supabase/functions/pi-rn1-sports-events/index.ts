// RN1 NBA play-by-play research. Public ESPN observations, private storage, scheduler auth.
// Read-only toward trading; never places orders, never infers private Maker placement times.
import postgres from "npm:postgres@3.4.3";
const dbUrl=Deno.env.get("SUPABASE_DB_URL")||"";
if(!dbUrl)throw Error("Database connection unavailable");
const db=postgres(dbUrl,{max:1,prepare:false,connect_timeout:10,idle_timeout:5});
const send=(v:unknown,code=200)=>Response.json(v,{status:code,headers:{"cache-control":"no-store"}});
const DAY_RE=/^nba-([a-z]{2,4})-([a-z]{2,4})-(20\d\d-\d\d-\d\d)$/;
const sleep=(n:number)=>new Promise(r=>setTimeout(r,n));
async function sha256(t:string):Promise<string>{
 const h=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(t));
 return [...new Uint8Array(h)].map(n=>n.toString(16).padStart(2,"0")).join("");
}
async function authorized(req:Request):Promise<boolean>{
 const t=req.headers.get("x-pi-scheduler-token")||"";
 if(!/^[a-f0-9]{64}$/.test(t))return false;
 const rows=await db.unsafe(
  "select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1",[await sha256(t)]);
 return rows.length===1;
}
async function getJSON(url:string):Promise<any>{
 for(let i=0;i<3;i++){
  const res=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(16000)});
  if((res.status===429||res.status===503)&&i<2){await sleep(1200*(i+1));continue}
  if(!res.ok)throw Error("ESPN HTTP "+res.status);
  const text=await res.text();
  if(text.length>14000000)throw Error("ESPN oversized payload");
  try{return {data:JSON.parse(text),digest:await sha256(text)}}catch{throw Error("ESPN invalid JSON")}
 }
 throw Error("ESPN retry budget");
}
function abbr(v:unknown){
 const k=String(v||"").trim().toUpperCase();
 const a:Record<string,string>={"GS":"GSW","GSW":"GSW","NY":"NYK","NYK":"NYK",
   "NO":"NOP","NOP":"NOP","PHO":"PHX","PHX":"PHX","UTAH":"UTA","BRK":"BKN",
   "WSH":"WAS","SA":"SAS","BKN":"BKN"};
 return a[k]||k;
}
function gameTeams(e:any):string[]{
 const c=e?.competitions?.[0]?.competitors;
 if(!Array.isArray(c)||c.length!==2)return [];
 return c.map((r:any)=>abbr(r?.team?.abbreviation)).sort();
}
function matchGame(games:any[],slug:string):any|null{
 const m=DAY_RE.exec(slug);if(!m)return null;
 const expected=[abbr(m[1]),abbr(m[2])].sort().join("-");
 const found=games.filter(e=>gameTeams(e).join("-")===expected);
 return found.length===1?found[0]:null; // never guess across ambiguous matchups
}
const epoch=(x:unknown)=>{const ms=Date.parse(String(x||""));return Number.isFinite(ms)?ms:null};
function normalizedPlays(items:any[],slug:string,id:string){
 const rows:any[]=[];
 for(let i=0;i<items.length;i++){
  const p=items[i];
  const timestamp=epoch(p?.wallclock); // game clock alone is NOT wall-clock UTC
  if(timestamp===null)continue;
  const id0=String(p?.id??p?.sequenceNumber??"").trim();
  if(!/^\d{1,24}$/.test(id0))continue;
  const h=Number(p?.homeScore),a=Number(p?.awayScore);
  const period=Number(p?.period?.number);
  const points=Number(p?.scoreValue);
  const seq=Number(p?.sequenceNumber);
  rows.push({
   event_slug:slug,play_id:id0,espn_event_id:id,
   play_at:new Date(timestamp).toISOString(),
   sequence_number:Number.isSafeInteger(seq)&&seq>=0?seq:null,
   period_number:Number.isInteger(period)&&period>=1&&period<=10?period:null,
   clock_text:String(p?.clock?.displayValue??"").slice(0,20),
   home_score:Number.isInteger(h)&&h>=0&&h<=300?h:null,
   away_score:Number.isInteger(a)&&a>=0&&a<=300?a:null,
   points:Number.isInteger(points)&&points>0&&points<=4?points:null,
   is_scoring:p?.scoringPlay===true,
   play_type:String(p?.type?.text??"").slice(0,100),
   play_text:String(p?.text??"").slice(0,220)
  });
 }
 // Prefer last record on duplicate play IDs; retain original observed wall-clock
 return [...new Map(rows.map(r=>[r.play_id,r])).values()];
}
async function scoreboard(date:string){
 const rows=await db.unsafe("select games,fetched_at from pi.rn1_nba_espn_scoreboards where game_day=$1::date",[date]);
 const recent=date>=new Date(Date.now()-86400000).toISOString().slice(0,10);
 if(rows.length&&(!recent||Date.now()-new Date(rows[0].fetched_at).getTime()<900000))
  return (typeof rows[0].games==="string"?JSON.parse(rows[0].games):rows[0].games) as any[];
 const url="https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates="+date.replaceAll("-","");
 const {data}=await getJSON(url);
 if(!Array.isArray(data?.events))throw Error("ESPN scoreboard events missing");
 const games=data.events as any[];
 await db.unsafe("insert into pi.rn1_nba_espn_scoreboards(game_day,games) values($1::date,($2::jsonb #>> '{}')::jsonb) on conflict(game_day) do update set games=excluded.games,fetched_at=now()",[date,JSON.stringify(games)]);
 return games;
}
async function queueRecent(){
 // New RN1 monitored NBA games can enter without replaying frozen 756k archives.
 await db.unsafe(`
 insert into pi.rn1_nba_espn_links(event_slug,game_day)
 select distinct x.slug,substring(x.slug from '[0-9]{4}-[0-9]{2}-[0-9]{2}$')::date
 from (
 select q->>'event_slug' slug
 from (select quotes from pi.rn1_quote_probe_runs order by id desc limit 80) r
 cross join lateral jsonb_array_elements(r.quotes) q
 )x
 where x.slug ~ '^nba-[a-z]{2,4}-[a-z]{2,4}-[0-9]{4}-[0-9]{2}-[0-9]{2}$'
 and substring(x.slug from '[0-9]{4}-[0-9]{2}-[0-9]{2}$')::date between current_date-7 and current_date
 on conflict do nothing`);
}
async function claim(max:number){
 return await db.unsafe(`
 with picked as (
  select event_slug from pi.rn1_nba_espn_links
  where ((status='pending' or (status='error' and attempts<3) or (status='partial' and updated_at<now()-interval '15 minutes' and game_day>=current_date-1))
  and game_day<=current_date)
  or (status='working' and lease_until<now())
  order by case when game_day<current_date then 0 else 1 end,game_day desc,event_slug
  for update skip locked limit $1
 )
 update pi.rn1_nba_espn_links l set status='working',
  lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now()
 from picked where l.event_slug=picked.event_slug
 returning l.event_slug,l.game_day::text as game_day,l.attempts`,[max]);
}
async function processGame(r:any){
 const slug=String(r.event_slug),date=String(r.game_day);
 try{
  const games=await scoreboard(date);
  const game=matchGame(games,slug);
  if(!game||!/^\d{7,15}$/.test(String(game.id||"")))throw Error("No unique NBA game match on ESPN scoreboard");
  const id=String(game.id);
  const {data,digest}=await getJSON("https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event="+id);
  if(!Array.isArray(data?.plays)||data.plays.length<2)throw Error("ESPN summary lacks completed play-by-play");
  const rows=normalizedPlays(data.plays,slug,id);
  if(rows.length<2)throw Error("No timestamped ESPN play-by-play");
  const scoreboardAt=epoch(game?.date);
  const chunk=120;
  for(let i=0;i<rows.length;i+=chunk){
   const sub=rows.slice(i,i+chunk);
   await db.unsafe(`
   insert into pi.rn1_nba_espn_plays(
    event_slug,play_id,espn_event_id,play_at,sequence_number,period_number,
    clock_text,home_score,away_score,points,is_scoring,play_type,play_text
   )
   select x.event_slug,x.play_id,x.espn_event_id,x.play_at,x.sequence_number,
    x.period_number,x.clock_text,x.home_score,x.away_score,x.points,x.is_scoring,
    x.play_type,x.play_text
   from jsonb_to_recordset(($1::jsonb #>> '{}')::jsonb) as x(
    event_slug text,play_id text,espn_event_id text,play_at timestamptz,
    sequence_number bigint,period_number smallint,clock_text text,
    home_score smallint,away_score smallint,points smallint,is_scoring boolean,
    play_type text,play_text text)
   on conflict(event_slug,play_id) do nothing`,[JSON.stringify(sub)]);
  }
  const finalized=game?.status?.type?.completed===true;
  await db.unsafe(`update pi.rn1_nba_espn_links
   set status=$11,lease_until=null,espn_event_id=$2,event_name=$3,
    scoreboard_at=$4::timestamptz,summary_sha256=$5,
    first_play_at=$6::timestamptz,last_play_at=$7::timestamptz,
    plays_seen=$8,plays_timed=$9,scoring_plays=$10,
    fetched_at=now(),updated_at=now(),last_error=null
   where event_slug=$1`,[slug,id,String(game.name||"").slice(0,120),
    scoreboardAt===null?null:new Date(scoreboardAt).toISOString(),digest,
    rows.map(x=>x.play_at).sort()[0],rows.map(x=>x.play_at).sort().at(-1),
    data.plays.length,rows.length,rows.filter(x=>x.is_scoring).length,finalized?'complete':'partial']);
  return {slug,status:finalized?'complete':'partial',plays:rows.length,scoring:rows.filter(x=>x.is_scoring).length};
 }catch(e){
  const message=String(e instanceof Error?e.message:e).slice(0,160);
  const exhausted=Number(r.attempts)>=3;
  await db.unsafe("update pi.rn1_nba_espn_links set status=$2,lease_until=null,last_error=$3,updated_at=now() where event_slug=$1",
   [slug,exhausted?"missing":"error",message]);
  return {slug,status:exhausted?"missing":"retry",error:message};
 }
}
Deno.serve(async(req:Request)=>{
 if(req.method!=="POST")return send({error:"POST only"},405);
 if(!await authorized(req))return send({error:"Unauthorized"},401);
 try{
  const body=await req.json().catch(()=>({}));
  if(body?.action==="nba_source_probe"){
   const urls=[
    "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261113",
    "https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261113",
    "https://cdn.espn.com/core/basketball/game?xhr=1&gameId=401909976",
    "https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json"
   ];
   const sources=[];
   for(const u of urls){
    try{
     const r=await fetch(u,{signal:AbortSignal.timeout(7000)});
     const txt=await r.text();
     let keys:string[]=[];
     if(r.ok){try{keys=Object.keys(JSON.parse(txt)).slice(0,12)}catch{}}
     sources.push({host:new URL(u).host,status:r.status,bytes:txt.length,keys});
    }catch(e){sources.push({host:new URL(u).host,error:String(e).slice(0,100)})}
   }
   return send({sources});
  }
  if(body?.action!=="nba_event_sync")return send({error:"Unsupported action"},400);
  await queueRecent();
  const picks=await claim(Math.min(6,Math.max(1,Number(body?.count)||4)));
  const outcomes=[];
  for(const p of picks)outcomes.push(await processGame(p));
  const n=await db.unsafe("select status,count(*)::int n from pi.rn1_nba_espn_links group by status order by status");
  return send({claimed:picks.length,outcomes,status:n});
 }catch(e){console.error("rn1 nba ESPN research",e);return send({error:"Research sync failed"},500)}
});
