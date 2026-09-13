import type {Track} from './album-player';
export type SourceCandidate=Track&{kind:string;platform:string;bvid?:string};
const normalize=(s:string)=>s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');
export function rankSources(results:SourceCandidate[],query:string){
  const q=normalize(query),seen=new Set<string>();
  return results.filter(t=>{const key=t.remote?t.remote.platform+':'+t.remote.id:t.bvid||t.source||t.title;if(seen.has(key))return false;seen.add(key);return true;}).map((t,i)=>{const title=normalize(t.title),artist=normalize(t.artist??'');return {t,i,score:(q===title?100:q.includes(title)&&title?60:0)+(artist&&q.includes(artist)?35:0)+(t.kind==='audio'?5:0)};}).sort((a,b)=>b.score-a.score||a.i-b.i).map(r=>r.t);
}
