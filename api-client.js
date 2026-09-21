const fs=require('node:fs');
const path=require('node:path');
class ApiError extends Error {
  constructor(status,retryAfter=0){super(status===401||status===403?'Account authorization needs attention':'Upstream service unavailable');this.status=status;this.retryAfter=retryAfter;}
}
function createClient({fetchImpl=fetch,credentials=()=>JSON.parse(fs.readFileSync(path.join(__dirname,'data/api-credentials.json'),'utf8')),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  let token=null,expires=0,refreshing=null;
  async function request(url,options={}) {
    for(let attempt=0;attempt<3;attempt++) {
      let response;
      try{response=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(12000)});}catch(e){if(attempt===2)throw new ApiError(0);await sleep(500*(attempt+1));continue;}
      if(response.ok)return response.status===204?null:response.json();
      const retry=Number(response.headers.get('retry-after'))||0;
      if((response.status===429||response.status>=500)&&attempt<2&&retry<=5){await sleep(Math.max(retry*1000,500*2**attempt));continue;}
      throw new ApiError(response.status,retry);
    }
  }
  async function accessToken(){
    if(token&&Date.now()<expires)return token;
    if(!refreshing)refreshing=(async()=>{const c=credentials().google;const r=await request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...c,grant_type:'refresh_token'})});if(!r.access_token)throw new ApiError(401);token=r.access_token;expires=Date.now()+Math.max(0,(r.expires_in||3600)-60)*1000;return token;})().finally(()=>{refreshing=null;});
    return refreshing;
  }
  async function google(route,params){
    const url=new URL('https://www.googleapis.com/calendar/v3/'+route);Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));
    for(let i=0;i<2;i++){const access=await accessToken();try{return await request(url,{headers:{Authorization:'Bearer '+access}});}catch(e){if(e.status!==401||i===1)throw e;token=null;expires=0;}}
  }
  async function todoist(route,params){const url=new URL('https://api.todoist.com/api/v1/'+route);Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));return request(url,{headers:{Authorization:'Bearer '+credentials().todoist.token}});}
  // Close is idempotent upstream, so the shared bounded retry is safe for it.
  async function todoistPost(route,body){return request('https://api.todoist.com/api/v1/'+route,{method:'POST',headers:{Authorization:'Bearer '+credentials().todoist.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
  async function pages(loader,field,cursorField){let cursor='',all=[],seen=new Set();for(let i=0;i<100;i++){const r=await loader(cursor);if(!Array.isArray(r[field]))throw new ApiError(502);all.push(...r[field]);cursor=r[cursorField];if(!cursor)return all;if(seen.has(cursor))throw new ApiError(502);seen.add(cursor);}throw new ApiError(502);}
  return {google,todoist,todoistPost,pages};
}
module.exports={createClient,ApiError};
