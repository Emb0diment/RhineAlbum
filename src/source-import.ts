import { escapeHtml as esc } from './html';
import type { Track } from './album-player';
import {rankSources,type SourceCandidate} from './source-ranking';
type Collection = { title: string; artist: string; tracks: Track[]; notice?: string; total?: number };
type Session = { title: string; artist: string; album: string; source: string; status: string };
type Video = { bvid: string; title: string; cover?: string; artist: string; pages: { cid: number; page: number; title: string; duration: number }[]; page: number };
export async function localRequest(path: string, data?: unknown) {
  let response: Response;
  try { response = await fetch('/api/' + path, { method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(path === 'playlist' ? 120000 : 30000) }); }
  catch { throw Error('本地助手未响应。请运行「启动播放器.cmd」，并从本机地址打开播放器。'); }
  let result; try { result = await response.json(); } catch { throw Error('当前页面未连接本地助手，请运行「启动播放器.cmd」。'); }
  if (!response.ok || result.error) throw Error(result.error ?? '操作失败，请稍后重试。');
  return result;
}

export class SourceImport {
  private dialog: HTMLDialogElement;
  private content: HTMLElement;
  private status: HTMLElement;
  private kind = 'local';
  private collection?: Collection;
  private video?: Video;
  private sessions: Session[] = [];
  private job?: string;
  private cancelled=false;
  private busy = false;
  private account?: import('./netease-account').NeteaseAccount;
  private generation = 0;
  private results: SourceCandidate[] = [];
  private defaultVersion=-1;
  private extras=new Set<number>();
  private prepared=new Map<number,Track>();
  private selectionWriter?: (tracks:Track[])=>Promise<void>;
  private pick?: (tracks: Track[]) => Promise<void>;
  constructor(private local: () => void, private save: (album: Collection) => Promise<void>, private match: (song: Session) => boolean, private beginSelection: () => (tracks:Track[])=>Promise<void>) {
    this.dialog = document.createElement('dialog'); this.dialog.className = 'album-import source-import';
    this.dialog.innerHTML = `<header><span>COLLECT / 音乐来源</span><button class="source-close" aria-label="关闭">×</button></header><h2>汇入你的音乐档案。</h2><nav class="source-tabs" aria-label="导入方式"><button data-source="local">本地文件</button><button data-source="playlist">QQ / 网易云</button><button data-source="search">找音源</button><button data-source="video">B 站音频</button><button data-source="now">正在播放</button></nav><div class="source-content"></div><p class="source-status" role="status" aria-live="polite"></p>`;
    document.body.append(this.dialog); this.content = this.dialog.querySelector('.source-content')!; this.status = this.dialog.querySelector('.source-status')!;
    this.dialog.querySelector('.source-tabs')!.insertAdjacentHTML('beforeend','<button data-source-action="favorites">B 站收藏夹</button>');
    this.dialog.querySelector('.source-close')!.addEventListener('click', () => { if (!this.busy) this.dialog.close(); else this.status.textContent = '请等待当前操作完成，或先取消下载。'; });
    this.dialog.addEventListener('cancel', e => { if (this.busy) e.preventDefault(); });
    this.dialog.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button'); if (!b) return;
      if (b.dataset.source) { if (!this.busy) this.tab(b.dataset.source); return; }
      const action = b.dataset.sourceAction;
      if(action==='favorites'&&!this.busy){this.dialog.close();void import('./bili-favorites').then(({BiliFavorites})=>new BiliFavorites(this.save).open());}
      if (action === 'local') { this.dialog.close(); this.local(); }
      if(action==='account'){this.dialog.close();void import('./netease-account').then(({NeteaseAccount})=>{this.account??=new NeteaseAccount(this.save);return this.account.open();});}
      if (action === 'parse') void this.parse();
      if (action === 'save') void this.saveCollection();
      if (action === 'download') void this.download();
      if (action === 'cancel') void this.cancel();
      if (action === 'refresh') void this.now();
      if (action === 'search') void this.search();
      if(action==='default-version')void this.chooseVersion(Number(b.dataset.index),true);
      if(action==='retry-version')void this.chooseVersion(Number(b.dataset.index),true);
      if (action === 'match') { const song = this.sessions[Number(b.dataset.index)]; if (song && this.match(song)) this.dialog.close(); else this.status.textContent = '未在本地音乐库中找到同名曲目。可以先导入文件，或将歌名保留到专辑中。'; }
      if (action === 'remember') {
        const song = this.sessions[Number(b.dataset.index)]; if (!song) return;
        const platform = /qq/i.test(song.source) ? 'QQ 音乐' : '网易云音乐';
        this.collection = { title: song.album || '正在聆听', artist: song.artist || platform, tracks: [{ title: song.title, artist: song.artist }] };
        void this.saveCollection();
      }
    });
    this.dialog.addEventListener('change', e => { const input=e.target as HTMLInputElement;if(input.id==='video-page')void this.loadQualities();if(input.dataset.version!==undefined)void this.chooseVersion(Number(input.dataset.version),false,input.checked); });
  }
  open() { this.selectionWriter=undefined;this.pick=undefined; this.tab('local'); this.dialog.showModal(); }
  find(query: string, pick?: (tracks: Track[]) => Promise<void>) { this.pick=pick;this.selectionWriter=pick;this.tab('search');this.content.querySelector<HTMLInputElement>('#source-query')!.value=query;if(!this.dialog.open)this.dialog.showModal();void this.search(); }
  private tab(kind: string) {
    this.generation++; this.kind = kind; this.collection = undefined; this.video = undefined; this.status.textContent = '';
    this.dialog.querySelectorAll<HTMLElement>('[data-source]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.source === kind)));
    if (kind === 'local') this.content.innerHTML = '<p>从电脑选择音频文件和封面。音频保留在当前浏览器，可离线播放。</p><button class="solid-button source-primary" data-source-action="local">选择本地音乐 ＋</button>';
    if (kind === 'playlist') this.content.innerHTML = '<button class="source-primary" data-source-action="account">网易云账号 · 扫码获取我的歌单 →</button><p>也可粘贴 QQ 音乐或网易云歌单链接，先预览曲目，再导入。无可用音源的曲目可绑定本地文件。</p><label>歌单链接<textarea id="source-link" rows="2" placeholder="https://music.163.com/#/playlist?id=…"></textarea></label><button class="solid-button source-primary" data-source-action="parse">解析歌单 →</button><div id="source-result"></div>';
    if (kind === 'video') this.content.innerHTML = '<p>粘贴 B 站音乐视频链接或 BV 号，选择分 P 后下载原始音轨，完成后加入音乐库。</p><label>视频链接<input id="source-link" placeholder="https://www.bilibili.com/video/BV…"></label><button class="solid-button source-primary" data-source-action="parse">解析视频 →</button><div id="source-result"></div>';
    if (kind === 'search') this.content.innerHTML = '<p>按歌名与歌手同时检索网易云、QQ 音乐和 B 站。自动使用最匹配的可用版本；可直接勾选多个版本。音频使用播放条所选音质，B 站默认下载最高可用音质。</p><label>歌名 / 歌手<input id="source-query" maxlength="120" placeholder="例如：歌名 歌手"></label><button class="solid-button source-primary" data-source-action="search">联网查找 →</button><div id="source-result"></div>';
    if (kind === 'now') { this.content.innerHTML = '<p>识别 Windows 媒体会话里 QQ／网易云的歌名、歌手与专辑。请先在对应客户端播放歌曲。</p><button class="solid-button source-primary" data-source-action="refresh">识别当前歌曲 ↻</button><div id="source-result"></div>'; void this.now(); }
  }
  private setBusy(value: boolean) {
    this.busy = value;
    this.dialog.querySelectorAll<HTMLInputElement>('[data-version]').forEach(e=>e.disabled=value||Number(e.dataset.version)===this.defaultVersion);
    this.dialog.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = value && b.dataset.sourceAction !== 'cancel');
  }
  private async parse() {
    if (this.busy) return;
    const link = this.content.querySelector<HTMLInputElement | HTMLTextAreaElement>('#source-link')!.value.trim(); if (!link) { this.status.textContent = '请先粘贴链接。'; return; }
    this.setBusy(true); this.status.textContent = '正在读取来源…';
    try {
      const result = this.content.querySelector('#source-result')!;
      if (this.kind === 'playlist') {
        this.collection = await localRequest('playlist', { link }); const c = this.collection!;
        if (!c.tracks?.length) throw Error('歌单中没有可读取的曲目。');
        result.innerHTML = `<div class="source-summary"><strong>${esc(c.title)}</strong><span>${esc(c.artist)} · ${c.tracks.length}${c.total && c.total !== c.tracks.length ? '/' + c.total : ''} 首</span></div><div class="source-preview">${c.tracks.slice(0,30).map((t,i)=>`<p><span>${String(i+1).padStart(2,'0')}</span>${esc(t.title)}<small>${esc(t.artist??'')}</small></p>`).join('')}${c.tracks.length>30?`<p>另有 ${c.tracks.length-30} 首，将一并导入</p>`:''}</div><button class="solid-button source-primary" data-source-action="save">导入 ${c.tracks.length} 首 ＋</button>`;
        this.status.textContent = c.notice ?? '';
      } else {
        this.video = await localRequest('video', { link }); const v = this.video!;
        result.innerHTML = `<div class="source-summary"><strong>${esc(v.title)}</strong><span>${esc(v.artist)}</span></div><label>选择音频分 P<select id="video-page">${v.pages.map(p=>`<option value="${p.cid}" ${p.page===v.page?'selected':''}>P${p.page} · ${esc(p.title)} · ${Math.round(p.duration/60)} 分钟</option>`).join('')}</select></label><button class="solid-button source-primary" data-source-action="download">下载音频并导入 ↓</button>`;
        this.status.textContent = '保存平台提供的 M4A 音轨；不进行有损转码。';
        await this.loadQualities();
      }
    } catch (e) { this.status.textContent = (e as Error).message; }
    finally { this.setBusy(false); }
  }
  private async saveCollection() {
    if (this.busy || !this.collection) return;
    this.setBusy(true);this.status.textContent='正在保存音乐档案…';
    try { await this.save(this.collection); this.dialog.close(); }
    catch(e){this.status.textContent=(e as Error).message;}
    finally{this.setBusy(false);}
  }
  private async download() {
    if (this.busy || !this.video) return;
    const cid = this.content.querySelector<HTMLSelectElement>('#video-page')!.value;
    this.setBusy(true); this.status.textContent = '正在建立下载任务…';
    try {
      const quality=this.content.querySelector<HTMLSelectElement>('#video-quality')?.value??'auto';
      let j = await localRequest('download', { bvid: this.video.bvid, cid, quality }); this.job = j.id;
      this.content.querySelector('#source-result')!.insertAdjacentHTML('beforeend','<div class="download-progress"><progress max="1" value="0"></progress><button data-source-action="cancel">取消下载</button></div>');
      while (['queued','resolving','downloading'].includes(j.state)) {
        await new Promise(r=>setTimeout(r,900));j=await localRequest('jobs/'+this.job);
        const progress = this.content.querySelector<HTMLProgressElement>('progress')!;
        if(j.total){progress.value=j.bytes/j.total;}else progress.removeAttribute('value');
        this.status.textContent = j.state==='resolving'?'正在解析音轨…':`已下载 ${(j.bytes/1048576).toFixed(1)} MB${j.total?' / '+(j.total/1048576).toFixed(1)+' MB':''}`;
      }
      if(j.state==='cancelled')throw Error('下载已取消。');
      if(j.state!=='complete')throw Error(j.error??'下载失败。');
      this.status.textContent='正在保存到音乐库…';
      const response=await fetch(j.file);if(!response.ok)throw Error('下载完成，但读取音频文件失败。');
      const file=await response.blob();
      this.collection={title:j.title,artist:j.artist,tracks:[{title:j.title,artist:j.artist,file,cover:this.video.cover,quality:j.quality,duration:j.duration,source:'https://www.bilibili.com/video/'+this.video.bvid}]};
      if(this.pick)await this.pick(this.collection.tracks);else await this.save(this.collection);this.dialog.close();
    } catch(e){this.status.textContent=(e as Error).message;}
    finally{this.job=undefined;this.content.querySelector('.download-progress')?.remove();this.setBusy(false);}
  }
  private async cancel(){if(!this.job)return;try{await localRequest('cancel',{id:this.job});this.cancelled=true;this.status.textContent='正在取消下载…';}catch(e){this.status.textContent=(e as Error).message;}}
  private async loadQualities(){
    if(!this.video)return;const cid=this.content.querySelector<HTMLSelectElement>('#video-page')?.value;if(!cid)return;
    const button=this.content.querySelector<HTMLButtonElement>('[data-source-action=download]');if(button)button.disabled=true;
    try{const j=await localRequest('video-quality',{bvid:this.video.bvid,cid});this.content.querySelector('.video-quality-field')?.remove();button?.insertAdjacentHTML('beforebegin',`<label class="video-quality-field">音质<select id="video-quality"><option value="auto">自动 · 最高可用</option>${j.qualities.map((q:{id:string;label:string})=>`<option value="${esc(q.id)}">${esc(q.label)}</option>`).join('')}</select></label>`);}
    catch(e){this.status.textContent=(e as Error).message;}finally{if(button)button.disabled=false;}
  }
  private renderVersions(){
    this.content.querySelector('#source-result')!.innerHTML='<div class="version-help">自动使用一个默认版本。直接勾选更多版本，会为每个版本新增槽位；取消勾选会移除本次新增的对应槽位。</div><div class="source-preview search-results">'+this.results.map((t,i)=>`<div class="search-result version-result"><input type="checkbox" data-version="${i}" aria-label="添加版本 ${esc(t.title+' '+t.platform)}" ${i===this.defaultVersion||this.extras.has(i)?'checked':''} ${i===this.defaultVersion?'disabled':''}><div><strong>${esc(t.title)}</strong><small>${esc(t.artist??'')} · ${esc(t.platform)}</small></div><button data-source-action="default-version" data-index="${i}" aria-pressed="${i===this.defaultVersion}">${i===this.defaultVersion?'默认版本':'设为默认'}</button><a href="${esc(t.source??'#')}" target="_blank" rel="noopener" aria-label="查看原始来源">↗</a></div>`).join('')+'</div>';
    this.setBusy(this.busy);this.lockDefault();
  }
  private async search(){
    if(this.busy)return;const query=this.content.querySelector<HTMLInputElement>('#source-query')!.value.trim();if(!query){this.status.textContent='请输入歌名或歌手。';return;}
    this.cancelled=false;this.setBusy(true);this.status.textContent='正在搜索并自动匹配默认版本…';
    try{const j=await localRequest('search',{query});this.results=rankSources(j.results,query);this.defaultVersion=-1;this.extras.clear();this.prepared.clear();this.selectionWriter??=this.pick??this.beginSelection();this.renderVersions();
      if(!this.results.length){this.status.textContent='没有找到候选版本。'+(j.failures??[]).join('；');return;}
      let matched=false;for(let i=0;i<Math.min(this.results.length,6);i++){try{this.status.textContent='正在检查默认版本：'+this.results[i].title;const track=await this.prepareVersion(i);await this.selectionWriter([track]);this.defaultVersion=i;matched=true;break;}catch{if(this.cancelled)break;}}
      this.renderVersions();this.status.textContent=matched?'已自动使用默认版本；还可以勾选更多版本，新版本会新增独立槽位。':'前几个候选暂不可用，可选择其他版本重试。';
      if(j.failures?.length)this.status.textContent+=' 部分来源暂不可用：'+j.failures.join('；');
      if(this.cancelled)this.status.textContent='已取消自动匹配，原版本未改变。';
    }catch(e){this.status.textContent=(e as Error).message;}finally{this.setBusy(false);this.lockDefault();}
  }
  private lockDefault(){const input=this.content.querySelector<HTMLInputElement>(`[data-version="${this.defaultVersion}"]`);if(input)input.disabled=true;}
  private async prepareVersion(index:number):Promise<Track>{
    const cached=this.prepared.get(index);if(cached)return cached;
    const t=this.results[index];if(!t)throw Error('找不到此版本。');let track:Track=t;
    if(t.kind==='video'){
      this.status.textContent='正在下载 '+t.title+'（最高可用音质）…';
      const v:Video=await localRequest('video',{link:t.source}),page=v.pages.find(p=>p.page===v.page)??v.pages[0];
      if(!page)throw Error('视频没有可读取的分 P。');
      let j=await localRequest('download',{bvid:v.bvid,cid:page.cid,quality:'auto'});this.job=j.id;
      this.content.querySelector('#source-result')!.insertAdjacentHTML('beforeend','<button data-source-action="cancel" class="source-primary">取消当前下载</button>');
      try{while(['queued','resolving','downloading'].includes(j.state)){await new Promise(r=>setTimeout(r,900));j=await localRequest('jobs/'+this.job);this.status.textContent='正在下载版本 · '+(j.bytes/1048576).toFixed(1)+' MB';}if(j.state!=='complete')throw Error(j.error??'下载已取消。');const response=await fetch(j.file);if(!response.ok)throw Error('音频读取失败。');track={title:j.title,artist:j.artist,file:await response.blob(),cover:v.cover,quality:j.quality,duration:j.duration,source:t.source};}
      finally{this.job=undefined;this.content.querySelector('[data-source-action=cancel]')?.remove();}
    }else if(t.remote){let quality='auto';try{quality=localStorage.getItem('rhine-audio-quality')??'auto';}catch{}await localRequest('source',{remote:t.remote,quality});}
    else if(!t.url&&!t.file)throw Error('此版本没有可用音源。');
    this.prepared.set(index,track);return track;
  }
  private async chooseVersion(index:number,asDefault:boolean,checked=true){
    if(this.busy){this.renderVersions();this.content.querySelectorAll<HTMLInputElement>('[data-version]').forEach(e=>e.disabled=true);return;}
    const previous=this.defaultVersion,extras=new Set(this.extras);this.cancelled=false;this.setBusy(true);
    try{if(asDefault||this.defaultVersion<0){await this.prepareVersion(index);this.defaultVersion=index;this.extras.delete(index);}else if(checked){await this.prepareVersion(index);this.extras.add(index);}else this.extras.delete(index);
      const tracks=[this.prepared.get(this.defaultVersion)!,...[...this.extras].map(i=>this.prepared.get(i)!)];await this.selectionWriter!(tracks);this.status.textContent='已使用默认版本'+(tracks.length>1?'，另有 '+(tracks.length-1)+' 个版本各占一个新增槽位。':'。');
    }catch(e){this.defaultVersion=previous;this.extras=extras;this.status.textContent=(e as Error).message;}
    finally{this.renderVersions();this.setBusy(false);this.lockDefault();}
  }
  private async now() {
    if(this.busy)return;const generation=this.generation;this.setBusy(true);this.status.textContent='正在读取 Windows 媒体会话…';
    try{
      const j=await localRequest('now-playing');if(generation!==this.generation)return;this.sessions=j.sessions??[];
      const result=this.content.querySelector('#source-result')!;
      result.innerHTML=this.sessions.map((s,i)=>`<div class="source-summary"><strong>${esc(s.title)}</strong><span>${esc(s.artist||'未知艺术家')} · ${esc(s.album||'未提供专辑')}</span><small>${/qq/i.test(s.source)?'QQ 音乐':'网易云音乐'} · ${s.status==='Playing'?'正在播放':s.status==='Paused'?'已暂停':s.status==='WindowTitle'?'窗口标题识别 · 播放状态未知':'未在播放'}</small><div><button data-source-action="match" data-index="${i}">在本地播放 →</button><button data-source-action="remember" data-index="${i}">保存歌名 ＋</button></div></div>`).join('');
      this.status.textContent=this.sessions.length?'识别只读取曲目信息，不会录制系统声音。':'没有识别到 QQ／网易云媒体会话。请检查客户端是否开启系统媒体控件支持，并开始播放。';
    }catch(e){this.status.textContent=(e as Error).message;}finally{this.setBusy(false);}
  }
}
