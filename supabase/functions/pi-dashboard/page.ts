// HTML is intentionally self-contained: no CDN JS, fonts, or third-party requests.
// All wallet/trader values are written through textContent (not innerHTML).
export function renderPage(url: string, key: string): string {
const page = `<!doctype html><html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Polymarket Intelligence — Cloud</title>
<style>
:root{--bg:#09121c;--side:#0c1926;--panel:#101f2d;--panel2:#142637;--line:#26394a;--text:#e6eef5;--muted:#90a4b7;--brand:#4fe4c4;--blue:#8fc0ff;--red:#ff8d8d;--shade:rgba(79,228,196,.07)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--text)}button,input,select{font:inherit}button{cursor:pointer}
.shell{display:grid;grid-template-columns:222px minmax(0,1fr);min-height:100vh}.sidebar{background:var(--side);border-right:1px solid var(--line);padding:27px 17px;display:flex;flex-direction:column;gap:20px}
.brand{display:flex;gap:12px;align-items:center;padding:6px 9px 20px}.mark{border:1px solid rgba(79,228,196,.5);width:36px;height:36px;display:grid;place-items:center;color:var(--brand);border-radius:11px;font-size:21px}
.brand b{display:block;letter-spacing:.01em}.small{font-size:12px;color:var(--muted)}nav{display:flex;flex-direction:column;gap:6px}
.nav{width:100%;text-align:left;border:0;border-radius:9px;background:transparent;color:var(--muted);padding:12px 14px;font-weight:600}.nav:hover{background:#182a38;color:var(--text)}.nav.on{background:#193a41;color:var(--brand)}
.note{margin-top:auto;border:1px solid var(--line);border-radius:11px;color:var(--muted);padding:14px;font-size:12px}.main{padding:33px 4vw;min-width:0;max-width:1700px;width:100%;margin:auto}
.kicker{text-transform:uppercase;letter-spacing:.16em;color:var(--brand);font-size:11px;font-weight:700}h1{font-size:clamp(24px,3vw,37px);line-height:1.17;margin:6px 0 7px;letter-spacing:-.03em}h2{font-size:19px;margin:0}p{margin:6px 0;color:var(--muted)}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.spread{justify-content:space-between}.button{background:#193b3e;color:var(--brand);border:1px solid #28665e;padding:9px 14px;border-radius:9px;font-weight:600}.button:hover{background:#225150}.button.secondary{background:transparent;color:var(--muted);border-color:var(--line)}.button.secondary:hover{color:var(--text)}.button.active{color:var(--text);border-color:var(--brand)}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:26px 0}.metric{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:17px;min-width:0}
.metric .label{color:var(--muted);font-size:12px}.metric .val{font-size:24px;letter-spacing:-.04em;font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.metric .val.green{color:var(--brand)}.metric .val.red{color:var(--red)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:19px;margin-bottom:17px;min-width:0}.cardhead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:15px}
.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:end}.filters label{display:flex;flex-direction:column;gap:5px;font-size:11px;font-weight:600;color:var(--muted)}
input,select{background:#0b1926;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px 10px;min-height:38px;max-width:100%}
input:focus,select:focus{outline:1px solid var(--brand)}input[type=checkbox]{min-height:0;width:16px;height:16px;accent-color:var(--brand)}
.checkbox{flex-direction:row!important;align-items:center;gap:8px!important;padding-bottom:9px}.tablewrap{overflow:auto;margin:0 -4px}
table{width:100%;border-collapse:collapse;white-space:nowrap;text-align:right}thead{color:var(--muted);font-size:11px;letter-spacing:.02em}td,th{padding:12px 10px;border-bottom:1px solid #243543}th:first-child,td:first-child{text-align:left}tbody tr{cursor:pointer}tbody tr:hover{background:#152d36}tbody tr:last-child td{border-bottom:0}.name{font-weight:650;color:#e5f7ff}.mono{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted)}
.green{color:var(--brand)}.red{color:var(--red)}.muted{color:var(--muted)}.foot{color:var(--muted);font-size:12px;line-height:1.7}.foot strong{color:var(--text)}
.banner{padding:12px 15px;background:var(--shade);border:1px solid #29544e;border-radius:10px;color:#afd9d3;font-size:12px;margin:17px 0}.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}
.chart{height:235px;width:100%;margin-top:10px;overflow:hidden}.chart svg{width:100%;height:100%}.chart path{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.badge{display:inline-block;background:#1e3638;color:var(--brand);font-size:11px;border-radius:6px;padding:3px 7px}.status{font-size:12px;color:var(--muted)}#toast{position:fixed;right:20px;bottom:22px;padding:12px 16px;background:#214445;color:#e4f8f3;border-radius:10px;box-shadow:0 6px 25px #0007;display:none;z-index:9}
#loginWrap{min-height:100vh;display:none;align-items:center;justify-content:center;padding:20px}.login{width:100%;max-width:410px;padding:35px;background:var(--panel);border:1px solid var(--line);border-radius:17px}.login h1{font-size:28px}.login form{display:grid;gap:12px;margin:24px 0}.login label{display:grid;gap:6px;font-size:12px;color:var(--muted)}.login button{width:100%}
#app{display:none}.hide{display:none!important}.loader{padding:25px;color:var(--muted);text-align:center}
@media(max-width:1000px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.grid2{grid-template-columns:1fr}.main{padding:24px 20px}}
@media(max-width:720px){.shell{grid-template-columns:1fr}.sidebar{padding:12px;gap:8px;position:sticky;top:0;z-index:3}.brand{padding:3px 0;margin:0}.mark{width:30px;height:30px}.brand .small,.note{display:none}nav{flex-direction:row;overflow:auto}.nav{text-align:center;padding:8px 10px;white-space:nowrap}.main{padding:20px 13px}.metric{padding:13px}.metric .val{font-size:20px}.filters{gap:7px}.card{padding:15px}.chart{height:200px}}
</style></head><body>
<div id="loginWrap"><section class="login">
<div class="kicker">Accès sécurisé</div><h1>Polymarket<br>Intelligence</h1>
<p>Connecte-toi avec le compte Supabase Auth autorisé pour accéder au pilote cloud.</p>
<form id="loginForm"><label>Adresse e-mail<input id="email" type="email" autocomplete="username" required></label>
<label>Mot de passe<input id="password" type="password" autocomplete="current-password" required></label>
<button class="button" type="submit">Se connecter</button></form>
<div class="foot">Les statistiques sont descriptives et ne constituent pas des recommandations de trading.</div>
<div id="loginError" class="red small"></div>
</section></div>
<div id="app" class="shell">
<aside class="sidebar"><div class="brand"><span class="mark">◈</span><div><b>Polymarket</b><span class="small">Intelligence Cloud</span></div></div>
<nav><button class="nav on" data-tab="ranking">Classements</button><button class="nav" data-tab="wallet">Analyse wallet</button><button class="nav" data-tab="data">Collecte & qualité</button></nav>
<div class="note"><b>Mode recherche</b><div style="margin-top:6px">PnL observé ≠ ROI du capital. Aucun signal copiable n'est encore validé.</div><button id="logout" class="button secondary" style="margin-top:14px">Déconnexion</button></div>
</aside><main class="main">
<div class="row spread"><span class="kicker">Analyses historiques · Supabase</span><span id="lastUpdated" class="status"></span></div>
<div id="content"></div></main></div><div id="toast" role="status"></div>
<script>
"use strict";
const BASE=__SUPABASE_URL__, KEY=__SUPABASE_KEY__, STORE="pi-cloud-auth-v1";
const $=(id)=>document.getElementById(id);
const fmt=(n,d=0)=>Number.isFinite(Number(n))?new Intl.NumberFormat("fr-FR",{maximumFractionDigits:d,minimumFractionDigits:d}).format(Number(n)):"—";
const money=(n)=>n===null||n===undefined?"—":(Number(n)>=0?"+":"−")+"$"+fmt(Math.abs(Number(n)),0);
const short=(s)=>s?String(s).slice(0,7)+"…"+String(s).slice(-5):"—";
let session=null,tab="ranking",page=1,currentWallet="",period="365d",rankFilter={days:90,max_day:100,positive:true,sort:"regularity",q:""};
function node(tag,txt,cls){const e=document.createElement(tag);if(txt!==undefined&&txt!==null)e.textContent=String(txt);if(cls)e.className=cls;return e;}
function toast(msg){const t=$("toast");t.textContent=msg;t.style.display="block";setTimeout(()=>t.style.display="none",3300);}
function loginScreen(message){session=null;sessionStorage.removeItem(STORE);$("app").style.display="none";$("loginWrap").style.display="flex";if(message)$("loginError").textContent=message;}
function authenticated(){ $("loginWrap").style.display="none";$("app").style.display="grid"; }
async function authRefresh(){
 if(!session?.refresh_token)return false;
 const r=await fetch(BASE+"/auth/v1/token?grant_type=refresh_token",{method:"POST",headers:{"apikey":KEY,"content-type":"application/json"},body:JSON.stringify({refresh_token:session.refresh_token})});
 if(!r.ok)return false;session=await r.json();sessionStorage.setItem(STORE,JSON.stringify(session));return true;
}
async function api(action,data={},retry=true){
 if(!session?.access_token)throw Error("Connexion requise");
 const r=await fetch(location.href,{method:"POST",headers:{"authorization":"Bearer "+session.access_token,"content-type":"application/json"},body:JSON.stringify(Object.assign({action},data))});
 if(r.status===401&&retry&&await authRefresh())return api(action,data,false);
 if(r.status===401){loginScreen("Accès refusé ou session expirée.");throw Error("Accès refusé");}
 const obj=await r.json();if(!r.ok)throw Error(obj.error||"Erreur de chargement");return obj;
}
function metric(label,value,cls){const m=node("div",null,"metric");m.append(node("div",label,"label"));m.append(node("div",value,"val "+(cls||"")));return m;}
function banner(t){const b=node("div",t,"banner");return b;}
function heading(title,subtitle){const h=node("div");h.append(node("h1",title));h.append(node("p",subtitle));return h;}
function setTab(next){tab=next;document.querySelectorAll(".nav").forEach(b=>b.classList.toggle("on",b.dataset.tab===next));render();}
function button(txt,fn,klass){const b=node("button",txt,"button "+(klass||""));b.addEventListener("click",fn);return b;}
function summary(o){
 const d=node("div",null,"metrics");
 d.append(metric("Wallets suivis",fmt(o.wallets)));
 d.append(metric("Points de PnL",fmt(o.observations)));
 d.append(metric("≥ 90 jours observés",fmt(o.long_histories)));
 d.append(metric("Stockage cloud",o.storage||"—"));
 return d;
}
async function renderRank(){
 const target=$("content");target.replaceChildren(heading("Explorer les traders","Classements descriptifs. Les résultats d'un wallet ne sont pas ceux d'une stratégie copiée."));
 const [overview,data]=await Promise.all([api("overview"),api("leaderboard",Object.assign({},rankFilter,{page,per:20}))]);
 $("lastUpdated").textContent="Dernière collecte : "+(overview.collected_at?overview.collected_at.slice(0,16).replace("T"," ")+" UTC":"inconnue");
 target.append(summary(overview));
 const f=node("section",null,"card");
 const head=node("div",null,"cardhead");head.append(node("h2","Filtres de présélection"));head.append(node("span","100 wallets · pilote biaisé par leaderboard","small"));f.append(head);
 const form=node("div",null,"filters");
 function select(label,options,value,cb){const a=node("label",label),input=node("select");options.forEach(([k,l])=>{const opt=node("option",l);opt.value=k;input.append(opt)});input.value=String(value);input.addEventListener("change",()=>cb(input.value));a.append(input);return a;}
 const searchLabel=node("label","Rechercher un trader");const search=node("input");search.placeholder="Nom ou adresse";search.value=rankFilter.q;search.addEventListener("input",()=>{rankFilter.q=search.value});searchLabel.append(search);form.append(searchLabel);
 form.append(select("Trier par",[["regularity","Linéarité R²"],["pnl","Progression PnL"],["recovery","PnL / drawdown"],["positive","Jours positifs (actifs)"],["concentration","Moins concentré"],["drawdown","Drawdown $ faible"]],rankFilter.sort,v=>rankFilter.sort=v));
 form.append(select("Historique minimum",[["30","30 jours"],["90","90 jours"],["180","180 jours"],["365","1 an"]],rankFilter.days,v=>rankFilter.days=Number(v)));
 form.append(select("Part maximum du meilleur jour",[["100","Sans limite"],["50","≤ 50 %"],["30","≤ 30 %"],["15","≤ 15 %"]],rankFilter.max_day,v=>rankFilter.max_day=Number(v)));
 const check=node("label",null,"checkbox");const box=node("input");box.type="checkbox";box.checked=rankFilter.positive;box.addEventListener("change",()=>rankFilter.positive=box.checked);check.append(box,node("span","PnL positif"));form.append(check);
 form.append(button("Appliquer",()=>{page=1;renderRank().catch(showError)}));
 f.append(form);target.append(f);
 const c=node("section",null,"card");const tHead=node("div",null,"cardhead");tHead.append(node("h2","Classement des profils"));tHead.append(node("span",fmt(data.total)+" profils filtrés","small"));c.append(tHead);
 const wrap=node("div",null,"tablewrap"),table=node("table"),thead=node("thead"),tr=node("tr");
 ["Trader","Jours","Progression PnL","DD PnL","PnL/DD","R²","Jours + actifs","Meilleur jour"].forEach(x=>tr.append(node("th",x)));thead.append(tr);table.append(thead);
 const tb=node("tbody");
 data.rows.forEach((r)=>{
  const row=node("tr");const one=node("td");one.append(node("div",r.name,"name"));one.append(node("div",short(r.wallet),"mono"));row.append(one);
  row.append(node("td",fmt(r.days)),node("td",money(r.pnl),Number(r.pnl)>=0?"green":"red"),node("td","$"+fmt(r.dd)),node("td",fmt(r.recovery,2)),node("td",fmt(r.r2,3)),node("td",fmt(r.positive_active,1)+" %"),node("td",fmt(r.concentration,1)+" %"));
  row.addEventListener("click",()=>{currentWallet=r.wallet;setTab("wallet")});tb.append(row);
 });table.append(tb);wrap.append(table);c.append(wrap);
 const footer=node("div",null,"row spread");footer.style.marginTop="16px";footer.append(node("div","Page "+page+" / "+Math.max(1,Math.ceil(data.total/20)),"small"));
 const buttons=node("div",null,"row");buttons.append(button("Précédent",()=>{page=Math.max(1,page-1);renderRank().catch(showError)},"secondary"),button("Suivant",()=>{page++;renderRank().catch(showError)},"secondary"));footer.append(buttons);c.append(footer);target.append(c);
 target.append(banner("Le R² mesure la proximité d'une tendance linéaire, pas la performance future. Le drawdown montré est une baisse du PnL observé en USDC ; ce n'est pas un drawdown du capital."));
}
function graph(points,key,title,color,isDd=false){
 const box=node("section",null,"card");box.append(node("h2",title));box.append(node("div",points.length+" observations affichées","small"));
 const holder=node("div",null,"chart");
 if(!points.length){holder.append(node("p","Aucune donnée pour cette période."));box.append(holder);return box;}
 const data=points.map(p=>Number(p[key])).map(n=>Number.isFinite(n)?(isDd?-n:n):null);
 const valid=data.filter(x=>x!==null),lo=Math.min(...valid),hi=Math.max(...valid);
 const WIDTH=920,HEIGHT=235,L=60,R=15,T=16,B=33,range=Math.max(1,hi-lo);
 const path=document.createElementNS("http://www.w3.org/2000/svg","path");
 const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox","0 0 "+WIDTH+" "+HEIGHT);svg.setAttribute("preserveAspectRatio","none");
 for(let j=0;j<4;j++){const y=T+j*(HEIGHT-T-B)/3;const grid=document.createElementNS("http://www.w3.org/2000/svg","line");grid.setAttribute("x1",String(L));grid.setAttribute("x2",String(WIDTH-R));grid.setAttribute("y1",String(y));grid.setAttribute("y2",String(y));grid.setAttribute("stroke","#284254");grid.setAttribute("stroke-dasharray","4 5");svg.append(grid);}
 let d="";for(let i=0;i<data.length;i++){if(data[i]===null)continue;const x=L+(WIDTH-L-R)*i/Math.max(1,data.length-1),y=T+(hi-data[i])/range*(HEIGHT-T-B);d+=(d?" L":"M")+x.toFixed(2)+" "+y.toFixed(2);}
 path.setAttribute("d",d);path.setAttribute("stroke",color);svg.append(path);
 const xlabel=document.createElementNS("http://www.w3.org/2000/svg","text");xlabel.setAttribute("x",String(L));xlabel.setAttribute("y",String(HEIGHT-6));xlabel.setAttribute("font-size","15");xlabel.setAttribute("fill","#92a6bb");xlabel.textContent=points[0].day;svg.append(xlabel);
 const end=document.createElementNS("http://www.w3.org/2000/svg","text");end.setAttribute("x",String(WIDTH-R));end.setAttribute("y",String(HEIGHT-6));end.setAttribute("text-anchor","end");end.setAttribute("font-size","15");end.setAttribute("fill","#92a6bb");end.textContent=points[points.length-1].day;svg.append(end);
 const valueLabel=document.createElementNS("http://www.w3.org/2000/svg","text");valueLabel.setAttribute("x",String(L));valueLabel.setAttribute("y",String(T+12));valueLabel.setAttribute("font-size","16");valueLabel.setAttribute("fill",color);valueLabel.textContent="Dernier : $"+fmt(Math.abs(Number(points[points.length-1][key])),0);svg.append(valueLabel);
 holder.append(svg);box.append(holder);return box;
}
async function renderWallet(){
 const target=$("content");target.replaceChildren(heading("Analyse wallet","PnL, stabilité, drawdowns et couverture des observations."));
 const search=node("section",null,"card");const line=node("div",null,"row");
 const inp=node("input");inp.style.flex="1";inp.style.minWidth="260px";inp.placeholder="Adresse 0x...";inp.value=currentWallet;line.append(inp,button("Ouvrir",()=>{currentWallet=inp.value.trim().toLowerCase();renderWallet().catch(showError)}));
 search.append(line);target.append(search);
 if(!currentWallet){target.append(banner("Sélectionne un trader depuis le classement ou saisis son adresse pour afficher ses courbes."));return;}
 const data=await api("wallet",{wallet:currentWallet,period});
 const c=node("section",null,"card");const h=node("div",null,"cardhead");
 const names=node("div");names.append(node("h2",data.info.name));names.append(node("div",data.info.wallet,"mono"));h.append(names);
 const periods=node("div",null,"row");[["90d","90 j"],["365d","1 an"],["all","Tout"]].forEach(([id,l])=>periods.append(button(l,()=>{period=id;renderWallet().catch(showError)},id===period?"active":"secondary")));h.append(periods);c.append(h);
 const facts=node("div",null,"metrics");facts.append(metric("Progression PnL observée",money(data.info.pnl),Number(data.info.pnl)>=0?"green":"red"));facts.append(metric("Max drawdown PnL","$"+fmt(data.info.dd)));facts.append(metric("Facteur PnL / DD",fmt(data.info.recovery,2)));facts.append(metric("Régularité R²",fmt(data.info.r2,3)));c.append(facts);
 c.append(node("div","Jours observés : "+fmt(data.info.days)+" · Progressions positives parmi les jours actifs : "+fmt(data.info.positive_active,1)+" % · Plus grosse journée : "+fmt(data.info.concentration,1)+" % des gains journaliers positifs","foot"));
 target.append(c);
 const cards=node("div",null,"grid2");cards.append(graph(data.series,"pnl","PnL économique observé (USDC)","#4fe4c4"));cards.append(graph(data.series,"dd","Drawdown observé du PnL (USDC)","#ff8d8d",true));target.append(cards);
 target.append(banner("ROI sur capital : non calculable · Drawdown sur capital (%) : non calculable · Gains d'une stratégie copiée : non validés. Le drawdown des graphiques est recalculé sur la période choisie, indépendamment du drawdown total affiché."));
}
async function renderData(){
 const target=$("content");target.replaceChildren(heading("Collecte & qualité","Santé des données stockées dans le schéma privé Supabase."));
 const v=await api("health");const stats=v.stats;
 const boxes=node("div",null,"metrics");boxes.append(metric("Wallets",fmt(stats.wallets)),metric("Séries quotidiennes",fmt(stats.pnl_rows)),metric("Trades détaillés",fmt(stats.trades)),metric("Positions détaillées",fmt(stats.positions)));target.append(boxes);
 target.append(banner("Les trades et les positions individuels sont encore à importer. Aucun ROI sur capital n'est certifié. Les observations PnL proviennent des APIs publiques Polymarket et restent partielles."));
 const c=node("section",null,"card");c.append(node("h2","Historique des collectes"));c.append(node("p","Dernière donnée synchronisée : "+(stats.last_collection||"inconnue")));
 const wrap=node("div",null,"tablewrap");const t=node("table");const h=node("tr");["Wallet","Flux","État","Lignes","Terminé"].forEach(x=>h.append(node("th",x)));const th=node("thead");th.append(h);t.append(th);const b=node("tbody");
 v.jobs.forEach(j=>{const tr=node("tr");[short(j.wallet),j.stream,j.status,fmt(j.rows_fetched),j.finished_at||"—"].forEach(x=>tr.append(node("td",x)));b.append(tr)});if(!v.jobs.length){const tr=node("tr");const cell=node("td","Le pilote initial a été importé ponctuellement ; aucune exécution planifiée enregistrée.","muted");cell.colSpan=5;tr.append(cell);b.append(tr)}t.append(b);wrap.append(t);c.append(wrap);target.append(c);
 const foot=node("p","Source : Supabase PostgreSQL, schéma privé pi. Les calculs historiques ne prouvent pas une rentabilité future.","foot");target.append(foot);
}
function showError(err){toast(err.message||"Erreur de chargement");const c=$("content");if(c)c.append(node("p",err.message||"Erreur","red"));}
async function render(){const c=$("content");c.replaceChildren(node("div","Chargement des données…","loader"));try{
 if(tab==="wallet")await renderWallet();else if(tab==="data")await renderData();else await renderRank();
}catch(e){showError(e);}}
document.querySelectorAll(".nav").forEach(b=>b.addEventListener("click",()=>setTab(b.dataset.tab)));
$("logout").addEventListener("click",()=>loginScreen(""));
$("loginForm").addEventListener("submit",async(e)=>{
 e.preventDefault();$("loginError").textContent="";
 try{
  const res=await fetch(BASE+"/auth/v1/token?grant_type=password",{method:"POST",headers:{"apikey":KEY,"content-type":"application/json"},body:JSON.stringify({email:$("email").value,password:$("password").value})});
  const x=await res.json();if(!res.ok)throw Error("Identifiants incorrects ou compte non confirmé");
  session=x;sessionStorage.setItem(STORE,JSON.stringify(x));$("password").value="";authenticated();await render();
 }catch(e){$("loginError").textContent=e.message||"Connexion impossible";}
});
try{session=JSON.parse(sessionStorage.getItem(STORE)||"null")}catch(e){session=null}
if(session?.access_token){authenticated();render()}else loginScreen("");
</script></body></html>`;
return page.replaceAll("__SUPABASE_URL__",JSON.stringify(url))
 .replaceAll("__SUPABASE_KEY__",JSON.stringify(key));
}
