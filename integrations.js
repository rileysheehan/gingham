const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createClient}=require('./api-client');
const {midnightIn,validZone}=require('./zone');
const {eventsBetween}=require('./ics');
const {safeFetchText}=require('./safe-fetch');
// The frame shows today plus four weeks ahead in one request; server background sync warms the same key.
const WINDOW_DAYS=28;
function normalize(events,calendar) {
  return events.filter(e=>e.status!=='cancelled'&&!(e.attendees||[]).some(a=>a.self&&a.responseStatus==='declined')).map(e=>({id:calendar+':'+e.id,uid:e.iCalUID||e.id,title:e.summary||'Busy',calendar,start:e.start.date||e.start.dateTime,end:e.end.date||e.end.dateTime,allDay:!!e.start.date,location:e.location||'',...(e.visibility==='private'||e.visibility==='confidential'?{private:true}:{})}));
}
function range(from,to){if(!/^\d{4}-\d{2}-\d{2}$/.test(from||'')||!/^\d{4}-\d{2}-\d{2}$/.test(to||'')||!(Date.parse(to)>Date.parse(from))||Date.parse(to)-Date.parse(from)>32*86400000)throw Error('Invalid dates');return {from,to};}
// A day starts at midnight where the household lives, not where the server runs.
function boundary(date,tz='UTC'){return midnightIn(tz,date);}
// How a list is marked on the frame: a glyph for a household list, or a monogram in the person's color (their calendar's, unless set).
// Its subhead is the first line of the Todoist project's description, so a list is explained where it is edited.
function listStyle(p,calendars){const color=[p.color,(calendars||[]).find(c=>c.name===p.name)?.color].find(c=>/^#[0-9a-f]{6}$/i.test(c||''))||'';
  const description=typeof p.description==='string'?p.description.split('\n')[0].replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/\*\*|__/g,'').trim().slice(0,120):'';
  return {name:p.name,icon:/^[a-z]{1,20}$/.test(p.icon||'')?p.icon:'list',person:p.person===true,kid:p.kid===true,color,description};}
// An event its author marked private is on a wall that guests can read. Unless the household says otherwise for that
// calendar, the wall shows that the time is taken and nothing more: 'busy' (the default), 'show', or 'hide'.
function discreet(events,policy){
  if(policy==='show')return events;
  if(policy==='hide')return events.filter(e=>!e.private);
  return events.map(e=>e.private?{...e,title:'Busy',location:'',busy:true}:e);
}
function normalizeTask(t,project,sections){return {id:t.id,title:t.content,priority:'p'+(5-t.priority),due:t.due?(t.due.datetime||t.due.date):'',project:project.name,section:sections.find(s=>s.id===t.section_id)?.name||'',labels:(t.labels||[]).join(', '),recurring:!!t.due?.is_recurring,assignee:t.responsible_uid?String(t.responsible_uid):''};}
// Whoever a task is assigned to, by their household name and their calendar's color rather than their Todoist handle.
function listPeople(collaborators,cfg){const named={},people={};(cfg.people||[]).forEach(p=>{named[String(p.id)]=p;});
  collaborators.forEach(c=>{const id=String(c.id),name=(named[id]&&named[id].name)||c.name||'';const color=[named[id]&&named[id].color,(cfg.calendars||[]).find(k=>k.name===name)?.color].find(x=>/^#[0-9a-f]{6}$/i.test(x||''))||'';
    if(name)people[id]={name,color};});
  return people;}

function create({api=createClient(),config=()=>JSON.parse(fs.readFileSync(path.join(__dirname,'data/sources.json'),'utf8')),cacheDir=path.join(__dirname,'data/cache'),secrets=()=>({}),feed=safeFetchText,local=null,microsoft=null,caldav=null,homeassistant=null,googletasks=null}={}) {
  // Lists that live in another app answer to the same four calls (lists, items, add, complete); see docs/SIGN-IN.md.
  const connected={microsoft,caldav,homeassistant,googletasks};
  const serviceFor=p=>{if(!p||!Object.prototype.hasOwnProperty.call(connected,p.source))return null;if(!connected[p.source])throw Error('Not connected here: '+p.source);return connected[p.source];};
  const cache=new Map();
  // A calendar by subscription link: {id,name,color,source:'ics'} in sources.json, and its link, which is a secret,
  // in credentials.json under ics.<id>. The text is kept five minutes and then re-asked for politely (If-None-Match).
  const feeds=new Map();
  async function feedText(url){
    const held=feeds.get(url);
    if(held&&Date.now()-held.at<300000)return held.text;
    const got=await feed(url,held&&held.etag?{headers:{'If-None-Match':held.etag}}:{});
    const text=got.status===304&&held?held.text:got.text;
    feeds.set(url,{at:Date.now(),etag:got.etag||(held&&held.etag)||'',text});
    if(feeds.size>60)feeds.delete(feeds.keys().next().value);
    return text;
  }
  // One calendar failing must not blank the others: it falls back to what it last gave, and is named as a problem.
  const lastGood=new Map();
  async function cached(key,loader){
    const file=cacheDir&&path.join(cacheDir,crypto.createHash('sha256').update(key+JSON.stringify(config())).digest('hex')+'.json');
    let entry=cache.get(key);
    if(!entry){entry={};if(file)try{entry.data=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){}cache.set(key,entry);}
    if(entry.pending)return entry.pending;
    if(entry.at&&Date.now()-entry.at<60000)return entry.data;
    if(entry.retryAt>Date.now()){if(entry.data)return {...entry.data,stale:true};throw Error('Sync temporarily unavailable');}
    entry.pending=(async()=>{try{
      const value=await loader();const data={...value,updatedAt:new Date().toISOString()};
      if(file){fs.mkdirSync(cacheDir,{recursive:true,mode:0o700});fs.writeFileSync(file+'.tmp',JSON.stringify(data),{mode:0o600});fs.renameSync(file+'.tmp',file);}
      entry.data=data;entry.at=Date.now();entry.retryAt=0;return data;
    }catch(e){entry.retryAt=Date.now()+Math.max(60000,(e.retryAfter||0)*1000);if(entry.data)return {...entry.data,stale:true};throw Error('Sync unavailable');}finally{entry.pending=null;}})();
    if(cache.size>40)cache.delete(cache.keys().next().value);
    return entry.pending;
  }
  async function calendar(from,to){range(from,to);return cached('calendar:'+from+':'+to,async()=>{
    const cfg=config(),zone=validZone(cfg.timezone)?cfg.timezone:'UTC',problems=[];let failed=0;
    const results=await Promise.all((cfg.calendars||[]).map(async c=>{
      try{
        let events;
        if(c.source==='ics'){
          const link=(secrets().ics||{})[c.id];if(!link)throw Error('No link for this calendar');
          events=eventsBetween(await feedText(link),{calendar:c.id,zone,fromDay:from,toDay:to});
        }else events=normalize(await api.pages(cursor=>api.google('calendars/'+encodeURIComponent(c.id)+'/events',{timeMin:boundary(from,zone),timeMax:boundary(to,zone),timeZone:zone,singleEvents:'true',showDeleted:'false',maxResults:'2500',...(cursor?{pageToken:cursor}:{})}),'items','nextPageToken'),c.id);
        events=discreet(events,c.private);
        lastGood.set(c.id,{window:from+to,events});return events;
      }catch(e){
        problems.push(c.name||c.id);const last=lastGood.get(c.id);
        if(last&&last.window===from+to)return last.events;
        failed++;return [];
      }
    }));
    // Every calendar failing with nothing remembered is an outage, and is reported as one.
    if((cfg.calendars||[]).length&&failed===cfg.calendars.length)throw Error('No calendar could be read');
    const seen=new Set();const events=results.flat().filter(e=>{const key=e.uid+'|'+e.start;if(seen.has(key))return false;seen.add(key);return true;});
    return {mode:'live',calendars:(cfg.calendars||[]).map(({id,name,color})=>({id,name,color})),events,from,to,...(problems.length?{problems}:{})};
  });}
  // One list failing (Todoist down, a token revoked) must not take the household's other lists with it: it falls back
  // to what it last gave and is named as a problem. Lists kept here never fail this way.
  const lastList=new Map();
  async function tasks(){return cached('tasks',async()=>{
    const cfg=config(),projects=cfg.projects||[],problems=[];let failed=0;const groups=await Promise.all(projects.map(async p=>{ try { const got=await (async()=>{
      // A list the household keeps here (lists.js) answers in the same shape as one of Todoist's.
      if(p.source==='local')return {tasks:(local?local.items(p.id):[]).map(i=>({id:i.id,title:i.title,priority:'p4',due:'',project:p.name,section:i.section||'',labels:'',recurring:false,assignee:''})),description:p.description,collaborators:[]};
      // So does one in Google Tasks, Microsoft To Do, on a CalDAV server or in Home Assistant, which have no sections or
      // assignees here.
      const service=serviceFor(p);
      if(service)return {tasks:(await service.items(p.remote,cfg.timezone)).map(t=>({...t,project:p.name,section:'',labels:'',assignee:''})),description:p.description,collaborators:[]};
      // The project itself only for its description; losing that never costs the list.
      const [tasks,sections,project,collaborators]=await Promise.all([...['tasks','sections'].map(route=>api.pages(cursor=>api.todoist(route,{project_id:p.id,limit:'200',...(cursor?{cursor}:{})}),'results','next_cursor')),api.todoist('projects/'+encodeURIComponent(p.id),{}).catch(()=>null),api.todoist('projects/'+encodeURIComponent(p.id)+'/collaborators',{}).then(r=>r.results||[]).catch(()=>[])]);
      return {tasks:tasks.filter(t=>!t.is_completed&&!t.is_deleted).map(t=>normalizeTask(t,p,sections)),description:project?.description,collaborators};
      })(); lastList.set(p.id,got); return got; } catch(e) { problems.push(p.name); const last=lastList.get(p.id); if(last)return last; failed++; return {tasks:[],description:p.description,collaborators:[]}; }
    }));
    if(projects.length&&failed===projects.length)throw Error('No list could be read');
    const people=listPeople(groups.flatMap(g=>g.collaborators),cfg);
    return {projects:projects.map(p=>p.name),lists:projects.map((p,i)=>listStyle({...p,description:groups[i].description},cfg.calendars)),people,tasks:groups.flatMap(g=>g.tasks),...(problems.length?{problems}:{})};
  });}
  // The only write this app makes. A task can be closed only while it is on the list the frame is
  // showing, which by construction limits writes to the configured household projects.
  const forget=()=>{const entry=cache.get('tasks');if(entry)entry.at=0;};
  // Adding at the wall or from a phone, to whichever kind of list it is. The list is named as the page names it.
  async function addTask(listName,title){
    const p=(config().projects||[]).find(x=>x.name===listName);
    if(!p)throw Object.assign(Error('No such list'),{code:'UNKNOWN_LIST'});
    const text=String(title||'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,200);
    if(!text)throw Object.assign(Error('Nothing to add'),{code:'EMPTY'});
    if(p.source==='local'){if(!local)throw Error('No local lists here');local.add(p.id,text);}
    else if(serviceFor(p))await serviceFor(p).add(p.remote,text);
    else await api.todoistPost('tasks',{content:text,project_id:p.id});
    forget();
  }
  async function closeTask(id){
    if(local&&local.has(id)){local.close(id);forget();return;}
    const current=await tasks(),task=current.tasks.find(t=>t.id===id);
    if(!task)throw Object.assign(Error('Unknown task'),{code:'UNKNOWN_TASK'});
    // Which service a task lives in is its list's, never a guess from the shape of its id.
    const p=(config().projects||[]).find(x=>x.name===task.project);
    if(serviceFor(p))await serviceFor(p).complete(id);
    else await api.todoistPost('tasks/'+encodeURIComponent(id)+'/close');
    const entry=cache.get('tasks');
    if(entry){entry.at=0;if(entry.data)entry.data={...entry.data,tasks:entry.data.tasks.filter(t=>t.id!==id||t.recurring)};}
  }
  return {calendar,tasks,closeTask,addTask};
}
let shared=null;
const live=name=>(...args)=>(shared||(shared=create()))[name](...args);
module.exports={calendar:live('calendar'),tasks:live('tasks'),closeTask:live('closeTask'),create,normalize,discreet,normalizeTask,listStyle,listPeople,range,boundary,WINDOW_DAYS};
