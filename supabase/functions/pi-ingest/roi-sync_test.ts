import {closesPageComplete} from "./roi-sync.ts";
function check(x:unknown,msg:string){if(!x)throw new Error(msg)}
Deno.test("finish when cursor exhausted regardless of scan",()=>{
 check(closesPageComplete("initial",false,[],null),"initial end");
 check(closesPageComplete("full",false,[],null),"full end");
});
Deno.test("recent scan stops after crossing 14 day overlap",()=>{
 const now=Date.parse("2026-11-15T00:00:00Z"),old=now-16*86400000,newer=now-5*86400000;
 check(closesPageComplete("recent",true,[newer,old],now-14*86400000),"recent overlap");
});
Deno.test("no early stop for initial or full reconciliation",()=>{
 const cutoff=Date.now(),old=cutoff-365*86400000;
 check(!closesPageComplete("initial",true,[old],cutoff),"initial");
 check(!closesPageComplete("full",true,[old],cutoff),"audit");
});
Deno.test("do not skip unsorted or incomplete source pagination",()=>{
 const cutoff=Date.parse("2026-11-15T00:00:00Z"),old=cutoff-20*86400000,newer=cutoff-4*86400000;
 check(!closesPageComplete("recent",true,[old,newer],cutoff-14*86400000),"unsorted");
 check(!closesPageComplete("recent",true,[newer,null,old],cutoff-14*86400000),"missing");
 check(!closesPageComplete("recent",true,[],cutoff-14*86400000),"empty");
});
Deno.test("keep paging if all records are within 14 day overlap",()=>{
 const now=Date.now();
 check(!closesPageComplete("recent",true,[now-1000,now-5000],now-14*86400000),"within window");
});
