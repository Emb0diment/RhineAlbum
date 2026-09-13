import {json,normalizeLink} from './providers.mjs';
export async function favorites(link,page=1){
 let id=String(link??'').trim();
 if(!/^\d{1,20}$/.test(id)){const u=await normalizeLink(link);if(!/(^|\.)bilibili\.com$/.test(u.hostname))throw Error('请粘贴 B 站收藏夹链接。');id=u.searchParams.get('fid')??u.searchParams.get('media_id')??u.pathname.match(/\/medialist\/detail\/(\d+)/)?.[1]??'';}
 if(!/^\d{1,20}$/.test(id))throw Error('未找到收藏夹 ID，请复制具体收藏夹的分享链接（含 fid），或输入收藏夹 ID。');
 if(!Number.isInteger(page)||page<1||page>10000)throw Error('页码不正确。');
 const j=await json(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${id}&pn=${page}&ps=20&platform=web&order=mtime&type=0`,'https://www.bilibili.com/');
 if(j.code!==0||!j.data?.info)throw Error('收藏夹暂不可读，可能已设为私密、已删除或平台限制访问。'+(j.message?' '+j.message:''));
 const d=j.data;
 return {id,title:d.info.title,artist:d.info.upper?.name??'B 站收藏夹',total:d.info.media_count??0,page,hasMore:!!d.has_more,items:(d.medias??[]).map(t=>({bvid:t.bvid??'',title:t.title,artist:t.upper?.name??'',cover:t.cover,duration:t.duration,available:t.type===2&&/^BV[\da-zA-Z]{10}$/.test(t.bvid??'')&&t.title!=='已失效视频'}))};
}
