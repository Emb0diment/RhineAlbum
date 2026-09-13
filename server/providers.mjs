const agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
import {neteaseCookie} from './netease-account.mjs';
export async function json(url, referer, init={}) {
  const credentials=new URL(url).hostname==='music.163.com'?neteaseCookie():'';
  let r;
  try { r = await fetch(url, { ...init, redirect:credentials?'error':'follow', headers: { 'User-Agent': agent, Referer: referer, ...(credentials?{Cookie:credentials}:{}), ...init.headers }, signal: AbortSignal.timeout(20000) }); }
  catch(e){const code=e.cause?.code??e.code;throw Error(['EACCES','EPERM'].includes(code)?'本地助手的联网权限受限，请重新运行「启动播放器.cmd」后重试。':e.name==='TimeoutError'?'连接来源平台超时，请稍后重试。':'本地助手无法连接来源平台，请检查网络或代理，并重新运行「启动播放器.cmd」。');}
  if(!r.ok) throw Error(`来源平台返回 ${r.status}，请稍后重试。`);
  return r.json();
}
const hostIs=(host,base)=>host===base||host.endsWith('.'+base);
export async function normalizeLink(text) {
  let raw=String(text??'').trim();
  const match=raw.match(/https?:\/\/[^\s<>"，]+/);if(match)raw=match[0];
  if(/^BV[\da-zA-Z]{10}$/.test(raw))return new URL('https://www.bilibili.com/video/'+raw);
  let u;try{u=new URL(raw)}catch{throw Error('请粘贴完整的歌单或 B 站视频分享链接。')}
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error('链接格式不支持。');
  const bases=['music.163.com','music.126.net','y.qq.com','c.y.qq.com','bilibili.com','b23.tv','163cn.tv'];
  if(!bases.some(b=>hostIs(u.hostname,b))||u.port)throw Error('仅支持 QQ 音乐、网易云音乐和 B 站链接。');
  for(let i=0;i<4&&(u.hostname==='b23.tv'||u.hostname==='163cn.tv'||u.pathname.includes('/n/yqq/')) ;i++){
    const r=await fetch(u,{redirect:'manual',headers:{'User-Agent':agent},signal:AbortSignal.timeout(15000)});
    if(!r.headers.get('location'))break;
    u=new URL(r.headers.get('location'),u);
    if(!bases.some(b=>hostIs(u.hostname,b))||u.port||!['https:','http:'].includes(u.protocol))throw Error('分享链接重定向到了不支持的地址。');
  }
  return u;
}
export function playlistIdentity(u) {
  const query = new URLSearchParams(u.search);
  const hashQuery=u.hash.split('?')[1];if(hashQuery)new URLSearchParams(hashQuery).forEach((v,k)=>query.set(k,v));
  if(hostIs(u.hostname,'music.163.com')){const id=query.get('id')??u.pathname.match(/playlist\/(\d+)/)?.[1];if(!id||!/^\d{1,20}$/.test(id))throw Error('未找到网易云歌单 ID。');return {platform:'netease',id}}
  if(hostIs(u.hostname,'qq.com')){const id=query.get('id')??query.get('disstid')??u.pathname.match(/playlist\/(\d+)/)?.[1];if(!id||!/^\d{1,20}$/.test(id))throw Error('请在 QQ 音乐中复制完整的歌单分享链接。');return {platform:'qq',id}}
  throw Error('这个链接不是 QQ 或网易云歌单。');
}
const neTrack=t=>({title:t.name,artist:(t.ar??t.artists??[]).map(a=>a.name).join(' / '),cover:(t.al??t.album)?.picUrl,remote:{platform:'netease',id:String(t.id)},source:`https://music.163.com/#/song?id=${t.id}`,duration:(t.dt??t.duration??0)/1000});
export async function artwork(ids) {
  if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>!/^\d{1,20}$/.test(String(id))))throw Error('曲目标识不正确。');
  const j=await json('https://music.163.com/api/song/detail?ids='+encodeURIComponent(JSON.stringify(ids.map(Number))),'https://music.163.com/');
  if(j.code!==200)throw Error('歌曲封面暂不可用。');
  return {covers:Object.fromEntries((j.songs??[]).map(t=>[String(t.id),neTrack(t).cover]).filter(([,cover])=>cover))};
}
export async function playlist(link) {
  const u=await normalizeLink(link),{platform,id}=playlistIdentity(u);
  if(platform==='netease'){
    const j=await json(`https://music.163.com/api/v6/playlist/detail?id=${id}&n=1000&s=0`,'https://music.163.com/');
    const p=j.playlist;if(j.code!==200||!p)throw Error('歌单不可访问，可能需要登录或已设为私密。');
    const tracks=(p.tracks??[]).map(neTrack);
    const wanted=(p.trackIds??[]).map(t=>String(t.id)),found=new Set(tracks.map(t=>t.remote.id));
    const missing=wanted.filter(id=>!found.has(id)).slice(0,Math.max(0,2000-tracks.length));
    for(let i=0;i<missing.length;i+=200){const ids=missing.slice(i,i+200);const more=await json(`https://music.163.com/api/song/detail?ids=${encodeURIComponent(JSON.stringify(ids.map(Number)))}`,'https://music.163.com/');(more.songs??[]).forEach(t=>tracks.push(neTrack(t)));}
    const order=new Map(wanted.map((id,i)=>[id,i]));tracks.sort((a,b)=>(order.get(a.remote.id)??0)-(order.get(b.remote.id)??0));
    return {title:p.name,artist:p.creator?.nickname??'网易云音乐',platform,total:p.trackCount??tracks.length,tracks,notice:tracks.length<(p.trackCount??0)?'平台只返回了部分曲目；已保留可读取的部分。':'已读取曲目清单，播放时检查平台音源可用性。'};
  }
  let info,tracks=[];
  for(let begin=0;begin<2000;begin+=500){
    const data={req_0:{module:'music.srfDissInfo.aiDissInfo',method:'uniform_get_Dissinfo',param:{disstid:Number(id),enc_host_uin:'',tag:1,userinfo:1,song_begin:begin,song_num:500}},comm:{ct:24,cv:0,uin:0,format:'json'}};
    const j=await qqRequest(data),p=j.req_0?.data;if(j.req_0?.code!==0||!p?.dirinfo)throw Error('QQ 歌单不可访问，请检查是否公开。');
    info=p.dirinfo;tracks.push(...(p.songlist??[]).map(qqTrack));if(tracks.length>=info.songnum||!p.songlist?.length)break;
  }
  return {title:info.title,artist:info.host_nick??'QQ 音乐',platform,total:info.songnum??tracks.length,tracks,notice:tracks.length<info.songnum?'仅导入前 2000 首曲目。':'已读取曲目清单；受限音源可在平台打开，或绑定本地文件。'};
}
const qqRequest=data=>json('https://u.y.qq.com/cgi-bin/musicu.fcg?data='+encodeURIComponent(JSON.stringify(data)),'https://y.qq.com/');
const qqTrack=t=>({title:t.songname??t.name,artist:(t.singer??[]).map(a=>a.name).join(' / '),cover:t.album?.mid?`https://y.gtimg.cn/music/photo_new/T002R300x300M000${t.album.mid}.jpg`:undefined,remote:{platform:'qq',id:t.songmid??t.mid,mediaMid:t.file?.media_mid},source:`https://y.qq.com/n/ryqq/songDetail/${t.songmid??t.mid}`,duration:t.interval??0});
export async function audioSource(remote,quality='auto') {
  if(!['auto','lossless','320','192','128'].includes(quality))throw Error('音质选项不正确。');
  if(remote?.platform==='netease'&&/^\d{1,20}$/.test(String(remote.id))){
    const br=quality==='lossless'?999000:quality==='auto'?320000:Number(quality)*1000;
    const j=await json(`https://music.163.com/api/song/enhance/player/url?ids=${encodeURIComponent('['+remote.id+']')}&br=${br}`,'https://music.163.com/');
    const t=j.data?.[0];if(!t?.url||t.freeTrialInfo)throw Error('平台没有提供完整可播放音源，请绑定本地音频，或到网易云播放。');
    const lossless=/flac|alac|wav/i.test(t.type??'');
    if(quality==='lossless'&&!lossless)throw Error('这首歌当前没有提供无损音源，请选择其他音质。');
    if(!['auto','lossless'].includes(quality)&&t.br<br)throw Error(`来源当前仅提供 ${Math.round(t.br/1000)} kbps，请选择自动或较低音质。`);
    const u=new URL(t.url);if(!hostIs(u.hostname,'music.126.net')&&!hostIs(u.hostname,'music.163.com'))throw Error('平台返回了未知音源。');u.protocol='https:';return {url:u.href,quality:lossless?'无损 '+String(t.type).toUpperCase():`${Math.round(t.br/1000)} kbps ${String(t.type??'audio').toUpperCase()}`};
  }
  if(remote?.platform==='qq'&&/^[a-zA-Z0-9]{5,30}$/.test(remote.id)){
    const media=/^[a-zA-Z0-9]{5,30}$/.test(remote.mediaMid??'')?remote.mediaMid:remote.id;
    const formats=quality==='auto'?[['M800','mp3','320 kbps MP3'],['M500','mp3','128 kbps MP3'],['C400','m4a','AAC / 平台默认']]:quality==='lossless'?[['F000','flac','无损 FLAC']]:quality==='320'?[['M800','mp3','320 kbps MP3']]:quality==='128'?[['M500','mp3','128 kbps MP3']]:[];
    if(!formats.length)throw Error('QQ 音乐不提供此码率选项，请选择 128、320 或自动。');
    for(const [prefix,ext,label] of formats){
      const data={req_0:{module:'vkey.GetVkeyServer',method:'CgiGetVkey',param:{guid:'1000000000',songmid:[remote.id],songtype:[0],filename:[prefix+media+'.'+ext],uin:'0',loginflag:0,platform:'20'}},comm:{uin:0,format:'json',ct:24,cv:0}};
      const j=await qqRequest(data),result=j.req_0?.data,purl=result?.midurlinfo?.[0]?.purl;if(!purl)continue;
      const u=new URL(purl,result.sip?.find(s=>s.startsWith('https:'))??'https://isure.stream.qqmusic.qq.com/');if(!hostIs(u.hostname,'qq.com'))throw Error('平台返回了未知音源。');u.protocol='https:';
      if(!u.pathname.split('/').pop().startsWith(prefix))continue;
      return {url:u.href,quality:label};
    }
    throw Error('QQ 音乐未提供所选音质的可播放音源，请更换音质、绑定本地文件或到平台播放。');
  }
  throw Error('曲目标识不正确。');
}
export async function videoInfo(link) {
  const u=await normalizeLink(link);
  if(!hostIs(u.hostname,'bilibili.com'))throw Error('请粘贴 B 站 BV 视频链接。');
  const bvid=u.pathname.match(/\b(BV[\da-zA-Z]{10})\b/)?.[1];if(!bvid)throw Error('未找到 BV 号；目前支持普通投稿视频。');
  const j=await json('https://api.bilibili.com/x/web-interface/view?bvid='+bvid,'https://www.bilibili.com/');
  if(j.code!==0||!j.data)throw Error(j.message??'视频无法访问。');
  const d=j.data;return {bvid,title:d.title,cover:d.pic,artist:d.owner?.name??'Bilibili',pages:d.pages.map(p=>({cid:p.cid,page:p.page,title:p.part,duration:p.duration})),page:Math.max(1,Number(u.searchParams.get('p'))||1)};
}
export async function videoAudio(bvid,cid,quality='auto') {
  if(!/^BV[\da-zA-Z]{10}$/.test(bvid)||!/^\d{1,20}$/.test(String(cid)))throw Error('视频标识不正确。');
  const info=await videoInfo('https://www.bilibili.com/video/'+bvid);
  const page=info.pages.find(p=>String(p.cid)===String(cid));if(!page)throw Error('视频分 P 不匹配。');
  const j=await json(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&qn=80`,'https://www.bilibili.com/video/'+bvid);
  if(j.code!==0)throw Error(j.message??'音频解析失败。');
  const options=(j.data?.dash?.audio??[]).filter(a=>(a.mimeType??a.mime_type)==='audio/mp4').sort((a,b)=>(b.bandwidth??0)-(a.bandwidth??0));
  if(!options.length)throw Error('没有可直接下载的音轨，视频可能需要登录或不提供独立音频。');
  const qualities=options.map(a=>({id:String(a.id),label:`AAC · ${Math.round((a.bandwidth??0)/1000)} kbps`,bitrate:a.bandwidth}));
  const chosen=quality==='auto'?options.slice(0,1):[options.find(a=>String(a.id)===String(quality))].filter(Boolean);
  if(!chosen.length)throw Error('视频未提供所选音质，请重新解析。');
  const urls=chosen.flatMap(a=>[a.baseUrl??a.base_url,...(a.backupUrl??a.backup_url??[])]).filter(Boolean).filter(raw=>{try{const u=new URL(raw);return u.protocol==='https:'&&!u.port&&['bilivideo.com','bilivideo.cn','akamaized.net'].some(b=>hostIs(u.hostname,b))}catch{return false}});
  if(!urls.length)throw Error('没有可访问的音频下载地址。');
  return {title:info.pages.length>1?`${info.title} · ${page.title}`:info.title,artist:info.artist,duration:page.duration,urls,qualities,quality:qualities.find(q=>q.id===String(chosen[0].id))?.label,referer:'https://www.bilibili.com/video/'+bvid};
}
const clean=s=>String(s??'').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
export async function searchSources(query) {
  const q=String(query??'').trim();if(!q||q.length>120)throw Error('请输入 1–120 个字符的歌名或歌手。');
  const providers=[
    ['网易云',async()=>{const j=await json('https://music.163.com/api/search/get/web?s='+encodeURIComponent(q)+'&type=1&offset=0&limit=12','https://music.163.com/');if(j.code!==200)throw Error('搜索暂不可用');return(j.result?.songs??[]).map(t=>({...neTrack(t),kind:'audio',platform:'网易云'}));}],
    ['QQ 音乐',async()=>{const j=await qqRequest({req_0:{module:'music.search.SearchCgiService',method:'DoSearchForQQMusicDesktop',param:{remoteplace:'txt.yqq.top',search_type:0,query:q,num_per_page:12,page_num:1}},comm:{ct:24,cv:0,uin:0,format:'json'}});if(j.req_0?.code!==0)throw Error('搜索暂不可用');return(j.req_0?.data?.body?.song?.list??[]).map(t=>({...qqTrack(t),kind:'audio',platform:'QQ 音乐'}));}],
    ['B 站',async()=>{const j=await json('https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword='+encodeURIComponent(q)+'&page=1','https://www.bilibili.com/');if(j.code!==0)throw Error(j.message??'搜索暂不可用');return(j.data?.result??[]).slice(0,12).map(t=>({title:clean(t.title),artist:clean(t.author),source:'https://www.bilibili.com/video/'+t.bvid,bvid:t.bvid,kind:'video',platform:'B 站'}));}],
  ];
  const responses=await Promise.allSettled(providers.map(([,fn])=>fn()));
  const results=[],failures=[];responses.forEach((r,i)=>{if(r.status==='fulfilled')results.push(...r.value);else failures.push(providers[i][0]+'：'+r.reason.message)});
  return {results,failures};
}
export {agent};
