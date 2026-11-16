// Pure, independently testable NBA team matching and no-vig odds conversion.
type Team={full:string;code:string;zone:string;nickname:string};
const teamInfo:[string,string,string][]=[
 ["Atlanta Hawks","ATL","America/New_York"],["Boston Celtics","BOS","America/New_York"],
 ["Brooklyn Nets","BKN","America/New_York"],["Charlotte Hornets","CHA","America/New_York"],
 ["Chicago Bulls","CHI","America/Chicago"],["Cleveland Cavaliers","CLE","America/New_York"],
 ["Dallas Mavericks","DAL","America/Chicago"],["Denver Nuggets","DEN","America/Denver"],
 ["Detroit Pistons","DET","America/New_York"],["Golden State Warriors","GSW","America/Los_Angeles"],
 ["Houston Rockets","HOU","America/Chicago"],["Indiana Pacers","IND","America/New_York"],
 ["Los Angeles Clippers","LAC","America/Los_Angeles"],["Los Angeles Lakers","LAL","America/Los_Angeles"],
 ["Memphis Grizzlies","MEM","America/Chicago"],["Miami Heat","MIA","America/New_York"],
 ["Milwaukee Bucks","MIL","America/Chicago"],["Minnesota Timberwolves","MIN","America/Chicago"],
 ["New Orleans Pelicans","NOP","America/Chicago"],["New York Knicks","NYK","America/New_York"],
 ["Oklahoma City Thunder","OKC","America/Chicago"],["Orlando Magic","ORL","America/New_York"],
 ["Philadelphia 76ers","PHI","America/New_York"],["Phoenix Suns","PHX","America/Phoenix"],
 ["Portland Trail Blazers","POR","America/Los_Angeles"],["Sacramento Kings","SAC","America/Los_Angeles"],
 ["San Antonio Spurs","SAS","America/Chicago"],["Toronto Raptors","TOR","America/Toronto"],
 ["Utah Jazz","UTA","America/Denver"],["Washington Wizards","WAS","America/New_York"]
];
const TEAM_LIST:Team[]=teamInfo.map(([full,code,zone])=>({full,code,zone,nickname:full.split(" ").slice(code==="PHI"?1:0).at(-1)!}));
const norm=(s:unknown)=>String(s??"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
function findTeam(v:unknown):Team|null{
 const x=norm(v);
 // Exact names and independently unambiguous NBA nicknames only.
 const extra:Record<string,string>={"76ers":"PHI","sixers":"PHI","trail blazers":"POR","blazers":"POR",
  "la clippers":"LAC","la lakers":"LAL","gs warriors":"GSW","ny knicks":"NYK"};
 const aliases=TEAM_LIST.filter(t=>norm(t.full)===x||norm(t.nickname)===x||norm(t.code)===x||extra[x]===t.code);
 return aliases.length===1?aliases[0]:null;
}
function homeDay(d:Date,zone:string){
 const parts=new Intl.DateTimeFormat("en-US",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(d);
 const part=(k:string)=>parts.find(p=>p.type===k)?.value||"";
 return part("year")+"-"+part("month")+"-"+part("day");
}
function implied(v:unknown):number|null{
 const p=Number(v);
 if(!Number.isInteger(p)||p===0||Math.abs(p)>100000||Math.abs(p)<100)return null;
 return p<0?-p/(-p+100):100/(p+100);
}
type OddsRow={provider:string;source_event_id:string;event_slug:string;bookmaker:string;
 home_team:string;away_team:string;start_at:string;first_seen_at:string;book_updated_at:string|null;
 home_american:number;away_american:number;home_fair_probability:number;away_fair_probability:number};
export function normalizePayload(body:any,receivedAt:Date):OddsRow[]{
 if(body?.success!==true||!Array.isArray(body?.data))throw Error("provider_payload_shape");
 const obs:OddsRow[]=[],now=receivedAt.getTime();
 for(const game of body.data.slice(0,40)){
  if(!game||typeof game!=="object")continue;
  const home=findTeam(game.home_team),away=findTeam(game.away_team);
  if(!home||!away||home.code===away.code||!Array.isArray(game.books))continue;
  const start=new Date(String(game.start_time||""));
  if(!Number.isFinite(start.getTime())||start.getTime()<=now||start.getTime()>now+72*3600e3)continue;
  const eventId=String(game.event_id||"");
  if(!/^[a-zA-Z0-9-]{3,80}$/.test(eventId))continue;
  const event_slug="nba-"+away.code.toLowerCase()+"-"+home.code.toLowerCase()+"-"+homeDay(start,home.zone);
  for(const book of game.books.slice(0,25)){
   if(!["draftkings","fanduel"].includes(String(book?.book||"").toLowerCase())||book.market!=="h2h"||!Array.isArray(book.outcomes))continue;
   const time=book.updated_at?new Date(String(book.updated_at)):null;
   if(time&&!Number.isFinite(time.getTime()))continue;
   if(time&&time.getTime()>now+60_000)continue;
   const homeOut=book.outcomes.find((o:any)=>findTeam(o?.name)?.code===home.code);
   const awayOut=book.outcomes.find((o:any)=>findTeam(o?.name)?.code===away.code);
   if(!homeOut||!awayOut)continue;
   const pHome=implied(homeOut.price),pAway=implied(awayOut.price);
   if(pHome===null||pAway===null)continue;
   const denom=pHome+pAway;
   // Disallow unreasonably huge bookmaker overround or inverted market.
   if(denom<0.98||denom>1.3)continue;
   obs.push({provider:"theoddsapi",source_event_id:eventId,event_slug,
    bookmaker:String(book.book).toLowerCase(),home_team:home.full,away_team:away.full,
    start_at:start.toISOString(),first_seen_at:receivedAt.toISOString(),
    book_updated_at:time?time.toISOString():null,
    home_american:Number(homeOut.price),away_american:Number(awayOut.price),
    home_fair_probability:pHome/denom,away_fair_probability:pAway/denom});
   if(obs.length>=100)return obs;
  }
 }
 return obs;
}
