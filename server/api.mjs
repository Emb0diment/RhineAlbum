import {playlist,audioSource,videoInfo,videoAudio,searchSources,artwork,agent} from './providers.mjs';
import {favorites} from './bili-favorites.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {accountStatus,createLogin,checkLogin,accountPlaylists,logout} from './netease-account.mjs';
const folder=fileURLToPath(new URL('../.local/audio/',import.meta.url));
const jobs=new Map();
const send=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>16384)throw Error('请求过大。')}try{return JSON.parse(text)}catch{throw Error('请求格式错误。')}}
async function download(job,bvid,cid,quality){
 const controller=new AbortController();job.controller=controller;job.state='resolving';
 const temp=path.join(folder,job.id+'.part');
 try {
  const source=await videoAudio(bvid,cid,quality);if(controller.signal.aborted)throw Error('下载已取消。');
  Object.assign(job,{title:source.title,artist:source.artist,duration:source.duration,quality:source.quality,state:'downloading'});
  fs.mkdirSync(folder,{recursive:true});
  let finished=false,lastError;
  for(const url of source.urls.slice(0,6)){
   if(controller.signal.aborted)throw Error('下载已取消。');
   job.bytes=0;job.total=0;
   let out;
   try{
    const r=await fetch(url,{redirect:'error',headers:{'User-Agent':agent,Referer:source.referer},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(180000)])});
    if(!r.ok||!r.body)throw Error(`下载源返回 ${r.status}`);
    const type=r.headers.get('content-type')??'';if(type.includes('text/')||type.includes('json'))throw Error('来源没有返回音频文件。');
    job.total=Number(r.headers.get('content-length')??0);if(job.total>250*1048576)throw Error('音频超过 250 MB，请选择较短的分 P。');
    out=fs.createWriteStream(temp);out.on('error',()=>{});
    for await(const chunk of r.body){job.bytes+=chunk.length;if(job.bytes>250*1048576)throw Error('音频超过 250 MB。');if(!out.write(chunk))await once(out,'drain');}
    out.end();await once(out,'finish');out=undefined;
    if(job.bytes<1024||(job.total&&job.total!==job.bytes))throw Error('音频下载不完整。');
    fs.renameSync(temp,path.join(folder,job.id+'.m4a'));finished=true;break;
   }catch(e){lastError=e;if(out){out.destroy();await once(out,'close').catch(()=>{});}if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  if(!finished)throw lastError??Error('下载失败。');
  job.state='complete';job.file='/api/audio/'+job.id;
 }catch(e){job.state=controller.signal.aborted?'cancelled':'failed';job.error=e.message;if(fs.existsSync(temp))fs.unlinkSync(temp);}
 finally {delete job.controller;}
}
const publicJob=({controller,...job})=>job;
function nowPlaying(){return new Promise((resolve,reject)=>{
 if(process.platform!=='win32'){reject(Error('当前播放识别需要 Windows 10 1809 或更高版本。'));return;}
 const script=fs.readFileSync(new URL('./now-playing.ps1',import.meta.url),'utf8');
 const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let out='',err='';const timer=setTimeout(()=>{child.kill();reject(Error('Windows 媒体会话响应超时。'))},12000);
 child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 child.on('error',e=>{clearTimeout(timer);reject(e)});
 child.on('exit',code=>{clearTimeout(timer);try{if(code)throw Error(err||'无法读取 Windows 媒体会话。');const result=JSON.parse(out.replace(/^\uFEFF/,''));if(result.error)throw Error('Windows 没有允许访问媒体会话：'+result.error);resolve(result)}catch(e){reject(e)}});
})}
export async function api(req,res){
 if(!req.url?.startsWith('/api/'))return false;
 const host=req.headers.host??'';
 if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host)){send(res,403,{error:'仅支持本机访问。'});return true;}
 const origin=req.headers.origin;
 if(origin&&!['http://'+host,'http://127.0.0.1:5173','http://localhost:5173'].includes(origin)){send(res,403,{error:'不允许此来源访问本地助手。'});return true;}
 try{
  const u=new URL(req.url,'http://'+host),p=u.pathname;
  if(req.method==='GET'&&p==='/api/status'){send(res,200,{local:true,version:2,windows:process.platform==='win32'});return true;}
  if(req.method==='GET'&&p==='/api/netease/status'){send(res,200,await accountStatus());return true;}
  if(req.method==='GET'&&p==='/api/cover'){
   const image=new URL(u.searchParams.get('url')??'');
   if(!['http:','https:'].includes(image.protocol)||image.port||image.username||!['music.126.net','qpic.y.qq.com','y.gtimg.cn','i0.hdslb.com','i1.hdslb.com','i2.hdslb.com'].some(h=>image.hostname===h||image.hostname.endsWith('.'+h)))throw Error('不支持此封面来源。');
   image.protocol='https:';const r=await fetch(image,{redirect:'error',signal:AbortSignal.timeout(15000)});const type=r.headers.get('content-type')??'';
   if(!r.ok||!/^image\/(jpeg|jpg|png|webp)(;|$)/i.test(type))throw Error('封面暂时无法读取。');
   if(Number(r.headers.get('content-length'))>10*1048576)throw Error('封面过大。');
   const bytes=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>10*1048576)throw Error('封面过大。');bytes.push(chunk);}
   res.writeHead(200,{'Content-Type':type,'Cache-Control':'private, max-age=604800','Content-Length':size});res.end(Buffer.concat(bytes));return true;
  }
  if(req.method==='GET'&&p==='/api/now-playing'){send(res,200,await nowPlaying());return true;}
  if(req.method==='GET'&&p.startsWith('/api/jobs/')){const job=jobs.get(p.slice(10));if(!job)throw Error('找不到这个下载任务。');send(res,200,publicJob(job));return true;}
  if(req.method==='GET'&&p.startsWith('/api/audio/')){
   const id=p.slice(11);if(!/^[0-9a-f-]{36}$/.test(id))throw Error('音频标识不正确。');
   const file=path.join(folder,id+'.m4a');if(!fs.existsSync(file))throw Error('音频文件不存在。');
   res.writeHead(200,{'Content-Type':'audio/mp4','Content-Length':fs.statSync(file).size,'Cache-Control':'no-store','Content-Disposition':`attachment; filename="rhine-${id}.m4a"`});fs.createReadStream(file).pipe(res);return true;
  }
  if(req.method!=='POST'||!(req.headers['content-type']??'').startsWith('application/json')){send(res,405,{error:'请求方法不支持。'});return true;}
  const input=await body(req);
  if(p==='/api/playlist')send(res,200,await playlist(input.link));
  else if(p==='/api/bili-favorites')send(res,200,await favorites(input.link,input.page??1));
  else if(p==='/api/netease/login')send(res,200,await createLogin());
  else if(p==='/api/netease/check')send(res,200,await checkLogin(input.ticket));
  else if(p==='/api/netease/playlists')send(res,200,await accountPlaylists(input.offset??0));
  else if(p==='/api/netease/logout')send(res,200,logout());
  else if(p==='/api/artwork')send(res,200,await artwork(input.ids));
  else if(p==='/api/source')send(res,200,await audioSource(input.remote,input.quality));
  else if(p==='/api/search')send(res,200,await searchSources(input.query));
  else if(p==='/api/video-quality'){const v=await videoAudio(input.bvid,input.cid);send(res,200,{qualities:v.qualities});}
  else if(p==='/api/video')send(res,200,await videoInfo(input.link));
  else if(p==='/api/download'){
   if(!/^BV[\da-zA-Z]{10}$/.test(String(input.bvid))||!/^\d{1,20}$/.test(String(input.cid)))throw Error('视频标识不正确。');
   if([...jobs.values()].some(j=>['resolving','downloading'].includes(j.state)))throw Error('已有一个下载任务，请等待完成或取消。');
   if(jobs.size>50)for(const [id,j] of jobs){if(!['resolving','downloading'].includes(j.state)){jobs.delete(id);break;}}
   const job={id:randomUUID(),state:'queued',bytes:0,total:0,title:'',artist:''};jobs.set(job.id,job);void download(job,input.bvid,input.cid,input.quality);send(res,202,publicJob(job));
  }else if(p==='/api/cancel'){const job=jobs.get(input.id);job?.controller?.abort();send(res,200,{cancelled:!!job?.controller});}
  else send(res,404,{error:'接口不存在。'});
 }catch(e){send(res,400,{error:e.message??'操作失败。'});}
 return true;
}
