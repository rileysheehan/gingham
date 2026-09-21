const {test}=require('node:test');const assert=require('node:assert/strict');const {normalize,normalizeTask,listStyle,listPeople,range}=require('../integrations');
test('Google adapter preserves exclusive all-day date boundaries and removes declined/cancelled events',()=>{const e={id:'a',summary:'Family',start:{date:'2026-11-01'},end:{date:'2026-11-02'}};const out=normalize([e,{...e,status:'cancelled'},{...e,attendees:[{self:true,responseStatus:'declined'}]}],'family');assert.equal(out.length,1);assert.equal(out[0].start,'2026-11-01');assert.equal(out[0].end,'2026-11-02');assert.equal(out[0].allDay,true);});
test('Calendar range rejects invalid and unbounded input',()=>{assert.throws(()=>range('oops','2026-10-01'));assert.throws(()=>range('2026-09-01','2027-01-01'));assert.throws(()=>range('2026-09-02','2026-09-01'));assert.deepEqual(range('2026-09-14','2026-09-21'),{from:'2026-09-14',to:'2026-09-21'});});

test('Todoist structured dates, sections and priorities survive mapping',()=>{const t=normalizeTask({id:'1',content:'Milk',priority:4,due:{date:'2026-11-01',is_recurring:true},section_id:'s',labels:['Store']},{name:'Grocery'},[{id:'s',name:'Dairy'}]);assert.equal(t.priority,'p1');assert.equal(t.due,'2026-11-01');assert.equal(t.section,'Dairy');assert.equal(t.recurring,true);});
const {createClient}=require('../api-client');
const response=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers});
test('Concurrent Google reads refresh once and retry an expired token',async()=>{let refresh=0,reads=0;const client=createClient({credentials:()=>({google:{refresh_token:'private'}}),fetchImpl:async url=>{if(String(url).includes('oauth2')){refresh++;return response({access_token:'token'+refresh,expires_in:3600});}reads++;return reads===1?response({},401):response({items:[]});}});await Promise.all([client.google('calendars/a/events',{}),client.google('calendars/b/events',{})]);assert.equal(refresh,2);assert.equal(reads,3);});
test('Pagination collects every page and rejects repeating cursors',async()=>{const c=createClient();assert.deepEqual(await c.pages(async cursor=>cursor?{results:[2],next_cursor:null}:{results:[1],next_cursor:'next'},'results','next_cursor'),[1,2]);await assert.rejects(c.pages(async()=>({results:[],next_cursor:'same'}),'results','next_cursor'));});
test('Rate limit respects Retry-After and does not expose provider bodies',async()=>{let calls=0,waits=[];const c=createClient({credentials:()=>({todoist:{token:'private'}}),sleep:async ms=>waits.push(ms),fetchImpl:async()=>++calls===1?response({},429,{'retry-after':'2'}):response({results:[]})});await c.todoist('tasks',{});assert.deepEqual(waits,[2000]);});
const {create}=require('../integrations');
const household=(posts)=>create({cacheDir:null,config:()=>({calendars:[],projects:[{id:'p1',name:'Chores'}]}),api:{pages:async loader=>(await loader('')).results,todoist:async route=>({results:route==='tasks'?[{id:'t1',content:'Trash',priority:1,due:{date:'2026-11-01',is_recurring:true}},{id:'t2',content:'Sheets',priority:1}]:[]}),todoistPost:async route=>{posts.push(route);}}});
test('Closing a task writes only for a task on the household lists',async()=>{const posts=[];const h=household(posts);await assert.rejects(h.closeTask('someone-elses-task'),{code:'UNKNOWN_TASK'});assert.deepEqual(posts,[]);await h.closeTask('t2');assert.deepEqual(posts,['tasks/t2/close']);});
test('A failed close reaches the caller and leaves the list intact',async()=>{const h=create({cacheDir:null,config:()=>({calendars:[],projects:[{id:'p1',name:'Chores'}]}),api:{pages:async loader=>(await loader('')).results,todoist:async route=>({results:route==='tasks'?[{id:'t2',content:'Sheets',priority:1}]:[]}),todoistPost:async()=>{throw Error('offline');}}});await assert.rejects(h.closeTask('t2'));assert.equal((await h.tasks()).tasks.length,1);});
test('Todoist POST sends the token and accepts an empty 204',async()=>{let seen;const c=createClient({credentials:()=>({todoist:{token:'private'}}),fetchImpl:async(url,options)=>{seen={url:String(url),method:options.method,auth:options.headers.Authorization};return new Response(null,{status:204});}});assert.equal(await c.todoistPost('tasks/t2/close'),null);assert.deepEqual(seen,{url:'https://api.todoist.com/api/v1/tasks/t2/close',method:'POST',auth:'Bearer private'});});
test('A list is marked by a known-shaped glyph, or as a person in their own or their calendar color',()=>{
  const calendars=[{name:'Mara',color:'#4793e0'}];
  assert.deepEqual(listStyle({name:'Grocery',icon:'cart'},calendars),{name:'Grocery',icon:'cart',person:false,kid:false,color:'',description:''});
  assert.deepEqual(listStyle({name:'June',person:true,kid:true,color:'#e0823d'},calendars),{name:'June',icon:'list',person:true,kid:true,color:'#e0823d',description:''});
  assert.equal(listStyle({name:'Chores',description:'Everything on a **schedule**\nSee [the wiki](https://x)'}).description,'Everything on a schedule');
  assert.equal(listStyle({name:'Mara',person:true},calendars).color,'#4793e0');
  const hostile=listStyle({name:'X',icon:'"><script>',person:'yes',color:'red;background:url(x)'},calendars);
  assert.deepEqual([hostile.icon,hostile.person,hostile.color],['list',false,'']);
});
test('A collaborator is named by the household, not by their Todoist handle, and takes their calendar color',()=>{
  const cfg={calendars:[{name:'Mara',color:'#4793e0'},{name:'Theo',color:'#38977b'}],people:[{id:'42119147',name:'Theo'}]};
  assert.deepEqual(listPeople([{id:668347,name:'Mara'},{id:42119147,name:'Chelpo30!'},{id:99,name:''}],cfg),
    {'668347':{name:'Mara',color:'#4793e0'},'42119147':{name:'Theo',color:'#38977b'}});
  assert.deepEqual(listPeople([{id:5,name:'Guest'}],{}),{'5':{name:'Guest',color:''}});
});
test('A household mixes sign-in and subscription calendars, and one failing calendar does not blank the rest',async()=>{
  const ics='BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:i1\r\nSUMMARY:Book club\r\nDTSTART;TZID=America/Chicago:20260928T183000\r\nDTEND;TZID=America/Chicago:20260928T200000\r\nEND:VEVENT\r\nEND:VCALENDAR';
  let feedDown=false,asked=[];
  const h=create({cacheDir:null,
    config:()=>({timezone:'America/Chicago',calendars:[{id:'mara@example.com',name:'Mara',color:'#4793e0'},{id:'theo',name:'Theo',color:'#38977b',source:'ics'}],projects:[]}),
    secrets:()=>({ics:{theo:'https://p01-caldav.icloud.com/published/2/secret'}}),
    feed:async(url)=>{asked.push(url);if(feedDown)throw Error('down');return {status:200,text:ics,etag:''};},
    api:{pages:async loader=>(await loader('')).items,google:async()=>({items:[{id:'g1',summary:'Coffee',start:{dateTime:'2026-09-25T11:30:00-05:00'},end:{dateTime:'2026-09-25T12:30:00-05:00'}}]})}});
  const first=await h.calendar('2026-09-23','2026-10-21');
  assert.deepEqual(first.events.map(e=>[e.calendar,e.title,e.start]),[['mara@example.com','Coffee','2026-09-25T11:30:00-05:00'],['theo','Book club','2026-09-28T23:30:00.000Z']]);
  assert.deepEqual(first.calendars,[{id:'mara@example.com',name:'Mara',color:'#4793e0'},{id:'theo',name:'Theo',color:'#38977b'}]);
  assert.ok(!JSON.stringify(first).includes('secret'),'the link never reaches the page');
  assert.equal(first.problems,undefined);
  assert.deepEqual(asked,['https://p01-caldav.icloud.com/published/2/secret']);
});
test('With no link, or every calendar down, the household is told rather than shown an empty week',async()=>{
  const make=(secrets,feed)=>create({cacheDir:null,config:()=>({calendars:[{id:'c1',name:'Shared',source:'ics'}],projects:[]}),secrets:()=>secrets,feed,api:{}});
  await assert.rejects(make({},async()=>({status:200,text:''})).calendar('2026-09-23','2026-10-21'));
  await assert.rejects(make({ics:{c1:'https://x.example/c.ics'}},async()=>{throw Error('down');}).calendar('2026-09-23','2026-10-21'));
  assert.deepEqual((await make({ics:{c1:'https://x.example/c.ics'}},async()=>({status:200,text:'BEGIN:VCALENDAR\nEND:VCALENDAR',etag:''})).calendar('2026-09-23','2026-10-21')).events,[],'an empty calendar is a fine answer');
  assert.deepEqual((await create({cacheDir:null,config:()=>({calendars:[],projects:[]}),api:{}}).tasks()).tasks,[],'a household with no lists has none, without asking anyone');
});
test('A list kept here and a Todoist list answer in one shape, and both can be added to and checked off',async()=>{
  const {createLists}=require('../lists');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const local=createLists({file:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'lists-')),'lists.json')}),posts=[];
  const h=create({cacheDir:null,local,config:()=>({calendars:[],projects:[{id:'L1',name:'Groceries',source:'local',icon:'cart',description:'By aisle'},{id:'p1',name:'Chores'}]}),
    api:{pages:async loader=>(await loader('')).results,todoist:async route=>({results:route==='tasks'?[{id:'t1',content:'Trash',priority:1}]:[]}),todoistPost:async(route,body)=>{posts.push([route,body]);}}});
  await h.addTask('Groceries','Milk');await h.addTask('Groceries','  Eggs  ');await h.addTask('Chores','Sweep');
  assert.deepEqual(posts,[['tasks',{content:'Sweep',project_id:'p1'}]],'a Todoist list is added to at Todoist');
  const all=await h.tasks();
  assert.deepEqual(all.tasks.map(t=>[t.project,t.title]),[['Groceries','Milk'],['Groceries','Eggs'],['Chores','Trash']]);
  assert.deepEqual(all.lists.map(l=>[l.name,l.icon,l.description]),[['Groceries','cart','By aisle'],['Chores','list','']]);
  const milk=all.tasks[0];assert.match(milk.id,/^Li[0-9a-f]{16}$/,'an id the close route accepts');
  await h.closeTask(milk.id);
  assert.deepEqual((await h.tasks()).tasks.map(t=>t.title),['Eggs','Trash'],'checked off is gone, without waiting out the cache');
  assert.equal(posts.length,1,'and Todoist was not asked about it');
  await assert.rejects(h.addTask('Nope','x'),{code:'UNKNOWN_LIST'});await assert.rejects(h.addTask('Groceries','   '),{code:'EMPTY'});
});
test('Todoist being down does not take the household\'s own lists with it',async()=>{
  const {createLists}=require('../lists');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const local=createLists({file:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'lists-')),'lists.json')});local.add('L1','Milk');
  let down=false;
  const h=create({cacheDir:null,local,config:()=>({calendars:[],projects:[{id:'L1',name:'Groceries',source:'local'},{id:'p1',name:'Chores'}]}),
    api:{pages:async loader=>(await loader('')).results,todoist:async route=>{if(down)throw Error('down');return {results:route==='tasks'?[{id:'t1',content:'Trash',priority:1}]:[]};}}});
  assert.deepEqual((await h.tasks()).tasks.map(t=>t.title),['Milk','Trash']);
  down=true;await h.addTask('Groceries','Eggs');      // adding forgets the cached answer, so this asks again
  const after=await h.tasks();
  assert.deepEqual(after.tasks.map(t=>t.title),['Milk','Eggs','Trash'],'Todoist\'s list is shown as it last was');
  assert.deepEqual(after.problems,['Chores']);
  const onlyTodoist=create({cacheDir:null,config:()=>({calendars:[],projects:[{id:'p1',name:'Chores'}]}),api:{pages:async l=>(await l('')).results,todoist:async()=>{throw Error('down');}}});
  await assert.rejects(onlyTodoist.tasks(),'with nothing at all to show, it is an outage and says so');
});

