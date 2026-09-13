import {randomUUID} from 'node:crypto';
let cookie='',profile=null,pending=null;
export const neteaseCookie=()=>cookie;
async function request(endpoint,params={},credentials=cookie){
  const url=new URL('https://music.163.com/api/'+endpoint);
  Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,String(v)));
  const r=await fetch(url,{redirect:'error',headers:{Referer:'https://music.163.com/','User-Agent':'Mozilla/5.0',...(credentials?{Cookie:credentials}:{})},signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error('网易云返回 '+r.status+'，请稍后重试。');
  return {data:await r.json(),cookies:r.headers.getSetCookie().map(c=>c.split(';')[0]).filter(c=>/^[\w-]+=/.test(c)).join('; ')};
}
export async function accountStatus(){
  if(!cookie)return {loggedIn:false};
  const {data}=await request('nuser/account/get');
  if(!data.profile){cookie='';profile=null;return {loggedIn:false};}
  profile={id:String(data.profile.userId),nickname:data.profile.nickname};
  return {loggedIn:true,profile};
}
export async function createLogin(){
  const {data}=await request('login/qrcode/unikey',{type:3},'');
  if(data.code!==200||!data.unikey)throw Error('网易云暂时无法生成登录二维码。');
  pending={ticket:randomUUID(),key:data.unikey,expires:Date.now()+180000};
  return {ticket:pending.ticket,url:'https://music.163.com/login?codekey='+encodeURIComponent(data.unikey),expires:pending.expires};
}
export async function checkLogin(ticket){
  if(!pending||pending.ticket!==ticket||Date.now()>pending.expires)return {state:'expired'};
  const current=pending,{data,cookies}=await request('login/qrcode/client/login',{type:3,key:current.key},'');
  if(pending!==current)return {state:'expired'};
  if(data.code===800){pending=null;return {state:'expired'};}
  if(data.code===801)return {state:'waiting'};
  if(data.code===802)return {state:'confirm'};
  if(data.code!==803)throw Error(data.message||'扫码状态暂时无法读取。');
  if(!cookies)throw Error('扫码已确认，但平台未返回登录凭据，请重新扫码。');
  cookie=cookies;pending=null;
  const status=await accountStatus();
  if(!status.loggedIn)throw Error('登录状态未生效，请重新扫码。');
  return {state:'authorized',...status};
}
export async function accountPlaylists(offset=0){
  if(!cookie)throw Error('请先登录网易云账号。');
  if(!profile)await accountStatus();
  if(!profile)throw Error('登录已失效，请重新扫码。');
  if(!Number.isInteger(offset)||offset<0||offset>10000)throw Error('歌单页码不正确。');
  const {data}=await request('user/playlist',{uid:profile.id,offset,limit:100,includeVideo:false});
  if(data.code!==200)throw Error(data.message||'无法读取账号歌单，请重新登录。');
  return {playlists:(data.playlist??[]).map(p=>({id:String(p.id),title:p.name,count:p.trackCount,owned:String(p.creator?.userId)===profile.id})),more:Boolean(data.more),offset};
}
export function logout(){cookie='';profile=null;pending=null;return {loggedIn:false};}
