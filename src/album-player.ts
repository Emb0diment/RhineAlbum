import { records } from './data';
import { escapeHtml as esc } from './html';
import { assetUrl } from './asset-url';
import './album-player.css';
import { readLocalTrack } from './local-track';
import { SourceImport, localRequest } from './source-import';

export type Track = { title: string; artist?: string; file?: Blob; url?: string; duration?: number; source?: string; cover?: string; coverFile?: Blob; quality?: string; remote?: { platform: 'netease' | 'qq'; id: string; mediaMid?: string } };
type Album = { slot: number; title: string; artist: string; tracks: Track[]; cover?: Blob; demo?: boolean };
type Hooks = { selected: () => number; changed: () => void; suppress: (playing: boolean) => void; notify: (text: string) => void; browse: (slot: number) => void; open: (slot: number) => void };
const shelves = ['声音实验', '私人收藏', '专辑档案', '聆听计划', '特别收藏'];
const oldShelves = ['工程研究', '生命科学', '机构档案', '能量研究', '特别项目'];
import { archiveColumns, categories, columnFiles } from './data';
archiveColumns.splice(0, archiveColumns.length, ...shelves);
categories.splice(0, categories.length, '全部专辑', ...shelves);
records.forEach((r, i) => {
  r.category = shelves[oldShelves.indexOf(r.category)] ?? shelves[2];
  Object.assign(r, { title: '空白专辑槽 ' + String(i + 1).padStart(2, '0'), en: 'UNRECORDED', department: '等待导入', date: '本地音乐库', lead: 'LOCAL AUDIO', clearance: 'EMPTY SLOT', abstract: '导入音频，将这张玻璃卡片变成你的专辑。', findings: [], source: 'https://github.com/LBEILC/RhineLabUI' });
});
const demos: Album[] = [{ slot: 0, title: '观测室', artist: 'LBEILC · 原创示范配乐', demo: true, tracks: [
  { title: 'Observatory / 观测室', url: assetUrl('audio/observatory-preview.mp3') },
  { title: 'Atmosphere / 气氛声部', url: assetUrl('audio/atmosphere.ogg') },
  { title: 'Motif / 主题声部', url: assetUrl('audio/motif.ogg') },
  { title: 'Pulse / 脉冲声部', url: assetUrl('audio/pulse.ogg') },
] }];
const clock = (n: number) => Number.isFinite(n) ? `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}` : '0:00';

export class AlbumPlayer {
  albums = new Map<number, Album>();
  audio = new Audio();
  private db?: IDBDatabase;
  private active = -1;
  private index = 0;
  private generation = 0;
  private objectUrl?: string;
  private coverUrls = new Map<number, string>();
  private repeat = 0;
  private shuffle = false;
  private history: string[] = [];
  private bar: HTMLElement;
  private dialog: HTMLDialogElement;
  private importing = false;
  private seeking = false;
  private ready: Promise<void>;
  private importer: SourceImport;
  private currentCollection = 0;
  private defaultCollection?: number;
  private collectionPage = 0;
  private rowOffsets = new Map<number,number>();
  private rows = [2,3,4,0,1].map(lane => columnFiles(lane));
  private bindings = new Map<number,{collection:number;track:number}>();
  private shuffled = new Map<number, number[]>();
  private trackCoverUrls = new WeakMap<Blob,string>();
  private repairing = false;
  private quality = 'auto';

  constructor(private hooks: Hooks) {
    try { const stored=localStorage.getItem('rhine-default-playlist');if(stored!==null&&/^\d+$/.test(stored))this.defaultCollection=Number(stored); } catch {}
    try { this.shuffle=localStorage.getItem('rhine-order-mode')==='shuffle'; } catch {}
    demos.forEach(a => this.apply(a));
    this.bar = document.createElement('section');
    this.bar.className = 'album-transport';
    this.bar.setAttribute('aria-label', '音乐播放控制');
    this.bar.innerHTML = `<button class="transport-art" data-player="reveal" aria-label="查看正在播放的专辑"><span>◎</span></button><div class="transport-title"><strong id="song-title">选择一张专辑</strong><span id="song-artist">RHINE LAB / AUDIO ARCHIVE</span></div><div class="transport-controls"><button data-player="shuffle" aria-label="随机播放" aria-pressed="false">⤨</button><button data-player="prev" aria-label="上一首">Ⅰ◀</button><button class="transport-play" data-player="toggle" aria-label="播放">▶</button><button data-player="next" aria-label="下一首">▶Ⅰ</button><button data-player="repeat" aria-label="循环模式" title="顺序播放">↻</button></div><div class="transport-seek"><span id="song-time">0:00</span><input id="song-seek" type="range" min="0" max="1000" value="0" aria-label="播放进度" disabled><span id="song-duration">0:00</span></div><button data-player="mute" aria-label="静音">♪</button><input id="song-volume" type="range" min="0" max="1" step="0.01" value="0.7" aria-label="音量"><div class="playing-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></div>`;
    document.querySelector('#stage')!.append(this.bar);
    document.querySelector('.column-navigation')!.insertAdjacentHTML('afterend','<div class="archive-library-tools"><button data-player="order" aria-label="切换档案与播放顺序"></button><button data-player="repair-covers">更新封面</button></div>');
    this.orderLabels();
    this.bar.insertAdjacentHTML('beforeend','<label class="quality-select" title="下一次联网播放使用此音质，本地文件保持原音质"><select aria-label="联网播放音质"><option value="auto">自动音质</option><option value="lossless">无损</option><option value="320">320 kbps</option><option value="192">192 kbps</option><option value="128">128 kbps</option></select><small id="actual-quality">原文件</small></label>');
    try { this.quality=localStorage.getItem('rhine-audio-quality')??'auto'; } catch {}
    if(!['auto','lossless','320','192','128'].includes(this.quality))this.quality='auto';
    const qualitySelect=this.bar.querySelector<HTMLSelectElement>('.quality-select select')!;qualitySelect.value=this.quality;
    qualitySelect.addEventListener('change',()=>{this.quality=qualitySelect.value;try{localStorage.setItem('rhine-audio-quality',this.quality);}catch{}this.hooks.notify('音质将在下一次联网播放时生效；本地文件保持原音质。');});
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'album-import';
    this.dialog.innerHTML = `<form><header><span>IMPORT / 本地专辑</span><button type="button" data-import-close aria-label="关闭">×</button></header><h2>把音乐放进档案。</h2><p>音乐和封面仅保存于当前浏览器。</p><label>专辑名称<input name="title" required maxlength="80" placeholder="例如：我的第一张专辑"></label><label>艺术家<input name="artist" maxlength="80" placeholder="未知艺术家"></label><label class="file-picker">选择音频文件<input name="tracks" type="file" accept="audio/*,.flac,.m4a,.ogg,.wav,.mp3,.aac,.opus" multiple required></label><small class="import-file-summary">可多选，按文件名排序</small><label>专辑封面（可选）<input name="cover" type="file" accept="image/png,image/jpeg,image/webp"></label><p class="import-status" role="status"></p><footer><button type="button" data-import-close>取消</button><button type="submit" class="solid-button">导入专辑 ↗</button></footer></form>`;
    document.body.append(this.dialog);
    this.dialog.querySelectorAll('[data-import-close]').forEach(b => b.addEventListener('click', () => { if (!this.importing) this.dialog.close(); }));
    this.dialog.addEventListener('cancel', e => { if (this.importing) e.preventDefault(); });
    this.dialog.querySelector('form')!.addEventListener('submit', e => { e.preventDefault(); void this.importFiles(); });
    this.dialog.querySelector<HTMLInputElement>('[name=tracks]')!.addEventListener('change', e => {
      const files = [...((e.target as HTMLInputElement).files ?? [])];
      this.dialog.querySelector('.import-file-summary')!.textContent = `${files.length} 首 · ${(files.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1)} MB`;
      const title = this.dialog.querySelector<HTMLInputElement>('[name=title]')!;
      if (!title.value && files.length) title.value = files[0].name.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]*/, '').slice(0, 80);
    });
    document.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-player], [data-track]');
      if (!b) return;
      if (b.dataset.track !== undefined) { const index=Number(b.dataset.track);if(this.active===this.currentCollection&&this.index===index)void this.toggle();else void this.play(this.currentCollection,index); return; }
      const action = b.dataset.player;
      if (action === 'import') void this.showImport();
      if (action === 'toggle') void this.toggle();
      if (action === 'play-album') { if(this.isSelectedPlaying())void this.toggle();else this.playSelected(); }
      if (action === 'prev') this.next(-1);
      if (action === 'next') this.next(1);
      if (action === 'shuffle' || action === 'order') this.toggleOrder();
      if(action==='repair-covers')void this.repairCovers();
      if (action === 'repeat') { this.repeat = (this.repeat + 1) % 3; b.textContent = this.repeat === 2 ? '↻¹' : '↻'; b.setAttribute('aria-pressed', String(this.repeat !== 0)); b.title = ['顺序播放', '专辑循环', '单曲循环'][this.repeat]; this.hooks.notify(b.title); }
      if (action === 'mute') { this.audio.muted = !this.audio.muted; b.setAttribute('aria-pressed', String(this.audio.muted)); b.setAttribute('aria-label', this.audio.muted ? '取消静音' : '静音'); }
      if (action === 'reveal') this.activate(this.active>=0?this.active:this.currentCollection,this.active>=0?this.index:this.trackIndex(this.hooks.selected()));
    });
    document.addEventListener('keydown', e => {
      if (this.dialog.open) { e.stopImmediatePropagation(); return; }
      if (document.querySelector('dialog[open]') || (e.target as HTMLElement).closest('textarea,select,[contenteditable=true]')) return;
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLButtonElement) && !document.querySelector('#stage')!.hasAttribute('inert') && !document.querySelector('#modal-root')?.textContent?.trim()) { e.preventDefault(); e.stopImmediatePropagation(); void this.toggle(); }
    }, true);
    this.audio.volume = .7;
    try { const v = Number(localStorage.getItem('rhine-album-volume') ?? '.7'); this.audio.volume = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : .7; } catch {}
    const volume = this.bar.querySelector<HTMLInputElement>('#song-volume')!;
    volume.value = String(this.audio.volume);
    volume.addEventListener('input', () => { this.audio.volume = Number(volume.value); try { localStorage.setItem('rhine-album-volume', volume.value); } catch {} });
    const seek = this.bar.querySelector<HTMLInputElement>('#song-seek')!;
    seek.addEventListener('input', () => { this.seeking = true; this.bar.querySelector('#song-time')!.textContent = clock(Number(seek.value) / 1000 * this.audio.duration); });
    seek.addEventListener('change', () => { if (Number.isFinite(this.audio.duration)) this.audio.currentTime = Number(seek.value) / 1000 * this.audio.duration; this.seeking = false; });
    this.audio.addEventListener('timeupdate', () => this.progress());
    this.audio.addEventListener('loadedmetadata', () => this.progress());
    this.audio.addEventListener('durationchange', () => this.progress());
    this.audio.addEventListener('play', () => this.sync());
    this.audio.addEventListener('pause', () => this.sync());
    this.audio.addEventListener('ended', () => this.next(1, true));
    this.audio.addEventListener('error', () => { this.sync(); this.hooks.notify('这首音频无法播放，请检查文件或尝试 MP3 / WAV。'); });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => { if(this.audio.paused)void this.toggle(); });
      navigator.mediaSession.setActionHandler('pause', () => this.audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.next(-1));
      navigator.mediaSession.setActionHandler('nexttrack', () => this.next(1));
      navigator.mediaSession.setActionHandler('seekto', d => { if (d.seekTime !== undefined) this.audio.currentTime = d.seekTime; });
    }
    this.ready = this.restore();
    this.importer = new SourceImport(() => { void this.showLocalImport(); }, a => this.saveExternal(a), song => {
      const normalized = (s: string) => s.toLocaleLowerCase().replace(/^\d+[\s._-]*/, '').replace(/[\s._\-·]+/g,'');
      for (const a of this.albums.values()) {
        const index = a.tracks.findIndex(t => (t.file || t.url || t.remote) && normalized(t.title) === normalized(song.title));
        if (index >= 0) { this.activate(a.slot, index); void this.play(a.slot, index); return true; }
      }
      return false;
    }, () => this.versionWriter());
    document.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-bind-track]');
      if (b) void this.bindFile(Number(b.dataset.bindTrack));
      const find=(e.target as HTMLElement).closest<HTMLElement>('[data-find-track]');if(find)this.findTrack(Number(find.dataset.findTrack));
    });
    const context = (document as Document & { modelContext?: { registerTool: (tool: object, options: { signal: AbortSignal }) => unknown } }).modelContext;
    if (context?.registerTool) {
      const lifecycle = new AbortController();
      try { void Promise.resolve(context.registerTool({
        name: 'list_local_albums', title: '查看本地专辑',
        description: '读取当前设备的专辑名称、艺术家和曲目列表，不读取或传输音频内容。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async (input: unknown) => {
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Expected an empty object');
          await this.ready;
          return [...this.albums.values()].map(a => ({ slot: a.slot, title: a.title, artist: a.artist, tracks: a.tracks.map(t => t.title) }));
        },
      }, { signal: lifecycle.signal })).catch(() => {}); } catch {}
      window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
    }
  }

  private apply(a: Album) {
    this.albums.set(a.slot, a);
    if(!a.demo&&a.tracks.length&&this.defaultCollection===undefined)this.setDefaultCollection(a.slot);

    if (a.cover) { const old = this.coverUrls.get(a.slot); if (old) URL.revokeObjectURL(old); this.coverUrls.set(a.slot, URL.createObjectURL(a.cover)); }
    this.paintRecords();
  }

  private setDefaultCollection(slot: number) {
    this.defaultCollection=slot;
    try { localStorage.setItem('rhine-default-playlist',String(slot)); } catch {}
  }

  private coverSource(url?: string) { return url ? url.startsWith('blob:') || url.startsWith('data:') ? url : '/api/cover?url=' + encodeURIComponent(url) : undefined; }
  private sequence(a: Album) {
    const straight=Array.from({length:a.tracks.length},(_,i)=>i);if(!this.shuffle)return straight;
    let sequence=this.shuffled.get(a.slot);
    if(!sequence||sequence.length!==a.tracks.length){sequence=straight;for(let i=sequence.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[sequence[i],sequence[j]]=[sequence[j],sequence[i]];}this.shuffled.set(a.slot,sequence);}
    return sequence;
  }
  private orderLabels(){this.bar.querySelector('[data-player=shuffle]')!.setAttribute('aria-pressed',String(this.shuffle));const button=document.querySelector('[data-player=order]')!;button.textContent=this.shuffle?'⇄ 乱序模式':'↓ 顺序模式';button.setAttribute('aria-pressed',String(this.shuffle));}
  private collectionKeys(){return [...this.albums.values()].filter(a=>a.tracks.length).sort((a,b)=>Number(!!a.demo)-Number(!!b.demo)||(a.slot===this.defaultCollection?-1:b.slot===this.defaultCollection?1:a.slot-b.slot)).map(a=>a.slot);}
  private focusTrack(collection:number,track:number){
    const keys=this.collectionKeys(),position=keys.indexOf(collection),a=this.albums.get(collection)!;
    this.collectionPage=Math.floor(position/this.rows.length);this.currentCollection=collection;
    const row=this.rows[position%this.rows.length],index=this.sequence(a).indexOf(track);
    this.rowOffsets.set(collection,Math.floor(index/row.length)*row.length);this.paintRecords();
    return row[index%row.length];
  }
  private toggleOrder(){const a=this.albums.get(this.currentCollection)!,track=this.trackIndex(this.hooks.selected());this.shuffle=!this.shuffle;this.shuffled.clear();try{localStorage.setItem('rhine-order-mode',this.shuffle?'shuffle':'ordered');}catch{}this.rowOffsets.clear();const slot=this.focusTrack(a.slot,track);this.orderLabels();this.hooks.browse(slot);this.hooks.changed();this.hooks.notify(this.shuffle?'每行歌单已切换为乱序。':'每行歌单已恢复顺序。');}
  canSelect(slot:number){return this.bindings.has(slot);}
  moveRowPage(slot:number,direction:number){
    const rowIndex=this.rows.findIndex(row=>row.includes(slot)),collection=this.collectionKeys()[this.collectionPage*this.rows.length+rowIndex],a=this.albums.get(collection);
    if(!a)return;
    const size=this.rows[rowIndex].length,pages=Math.ceil(a.tracks.length/size),current=Math.floor((this.rowOffsets.get(collection)??0)/size);
    this.rowOffsets.set(collection,((current+direction)%pages+pages)%pages*size);this.paintRecords();
  }
  private trackIndex(slot:number){return this.bindings.get(slot)?.track??0;}
  private artwork(t: Track, slot: number) { if(t.coverFile){let url=this.trackCoverUrls.get(t.coverFile);if(!url){url=URL.createObjectURL(t.coverFile);this.trackCoverUrls.set(t.coverFile,url);}return url;}return this.coverSource(t.cover)||this.coverUrls.get(slot); }
  private async repairCovers(){
    if(this.repairing)return;await this.ready;this.repairing=true;const slot=this.currentCollection,a=this.albums.get(slot)!;const button=document.querySelector<HTMLButtonElement>('[data-player=repair-covers]')!;button.disabled=true;button.textContent='读取封面…';let found=0;
    try{const tracks=[...a.tracks];for(let i=0;i<tracks.length;i++){const t=tracks[i];if(t.file&&!t.coverFile){const metadata=await readLocalTrack(t.file,t.title);if(metadata.coverFile){tracks[i]={...t,coverFile:metadata.coverFile};found++;}}}
      const missing=tracks.filter(t=>!t.coverFile&&t.remote?.platform==='netease'&&!t.cover);
      let unavailable=false;for(let i=0;i<missing.length;i+=100){try{const result=await localRequest('artwork',{ids:missing.slice(i,i+100).map(t=>t.remote!.id)});for(const t of missing.slice(i,i+100)){const cover=result.covers[t.remote!.id];if(cover){const index=tracks.indexOf(t);tracks[index]={...t,cover};found++;}}}catch{unavailable=true;}}
      const latest=this.albums.get(slot)!;const updated={...latest,tracks:latest.tracks.map((t,i)=>tracks[i]?.coverFile?{...t,coverFile:tracks[i].coverFile}:tracks[i]?.cover?{...t,cover:tracks[i].cover}:t)};await this.persist(updated);this.apply(updated);this.paintRecords();this.hooks.changed();this.hooks.notify('已补齐 '+found+' 张封面，并重试图片加载。'+(unavailable?'部分网络封面暂不可用。':''));
    }catch{this.hooks.notify('封面更新失败，请检查本地助手和存储空间。');}finally{this.repairing=false;button.disabled=false;button.textContent='更新封面';}
  }
  private paintRecords() {
    const keys=this.collectionKeys();this.bindings.clear();
    this.rows.forEach((row,r)=>{const a=this.albums.get(keys[this.collectionPage*this.rows.length+r]);
      row.forEach((slot,position)=>{const sequence=a?this.sequence(a):[],index=sequence.length?sequence[(this.rowOffsets.get(a!.slot)??0)+position]:undefined,t=index===undefined?undefined:a!.tracks[index];
        if(!a||!t){Object.assign(records[slot],{title:a?'本页暂无歌曲':'空白歌单行',en:'EMPTY PLAYLIST',department:'等待导入歌单',date:'',lead:'',clearance:'EMPTY SLOT',cover:undefined,abstract:'导入歌单后，这一行将展示其中的歌曲。'});return;}
        this.bindings.set(slot,{collection:a.slot,track:index!});Object.assign(records[slot],{title:t.title,en:a.title,department:t.artist||a.artist,date:(index!+1)+' / '+a.tracks.length,lead:t.artist||a.artist,clearance:t.file||t.url?'AUDIO READY':'ONLINE SOURCE',cover:this.artwork(t,a.slot),abstract:'当前歌单：'+a.title,source:t.source||'https://github.com/LBEILC/RhineLabUI'});
      });
    });window.dispatchEvent(new Event('rhine-covers-changed'));
  }
  private activate(slot:number,track=0){if(!this.albums.get(slot)?.tracks[track])return;const visual=this.focusTrack(slot,track);this.hooks.open(visual);this.hooks.changed();}
  private isSelectedPlaying(){return this.active===this.currentCollection&&this.index===this.trackIndex(this.hooks.selected());}
  playSelected(){const selected=this.bindings.get(this.hooks.selected());if(selected)void this.play(selected.collection,selected.track);}
  selectionChanged() {
    const binding=this.bindings.get(this.hooks.selected());if(!binding)return;
    this.currentCollection=binding.collection;
    const slot=binding.collection,index=binding.track,a=this.albums.get(slot),t=a?.tracks[index];
    if(!a||!t)return;
    // Browsing must not change the loaded source, progress, or media session.
    if(this.active>=0){this.sync();return;}
    this.bar.querySelector('#actual-quality')!.textContent=t.quality??(t.remote?'待播放':'原文件');
    this.bar.querySelector('#song-title')!.textContent=t.title;
    this.bar.querySelector('#song-artist')!.textContent=t.artist||a.artist;
    const cover=this.artwork(t,slot),art=this.bar.querySelector('.transport-art')!;
    art.setAttribute('aria-label','查看所选歌曲：'+t.title);
    if(art.getAttribute('data-cover')!==(cover??'')){art.setAttribute('data-cover',cover??'');art.innerHTML=cover?`<img src="${esc(cover)}" alt="">`:'<span>◎</span>';}
    this.progress();this.sync();
  }
  switchPlaylist(direction:number){const keys=this.collectionKeys();if(keys.length<2){this.hooks.notify('导入另一张歌单后即可切换。');return;}const next=keys[(keys.indexOf(this.currentCollection)+direction+keys.length)%keys.length];this.hooks.browse(this.focusTrack(next,0));this.hooks.changed();}
  stepTrack(direction:number){const a=this.albums.get(this.currentCollection)!,sequence=this.sequence(a),index=(sequence.indexOf(this.trackIndex(this.hooks.selected()))+direction+a.tracks.length)%a.tracks.length;return this.focusTrack(a.slot,sequence[index]);}
  navigation(){const keys=this.collectionKeys(),a=this.albums.get(this.currentCollection)!;return {title:a.title,index:keys.indexOf(a.slot)+1,count:keys.length,track:this.sequence(a).indexOf(this.trackIndex(this.hooks.selected()))+1,tracks:a.tracks.length};}
  key(slot:number){const b=this.bindings.get(slot);return b?b.collection+':'+b.track:'';}
  openKey(key: string) { const [slot,track]=key.split(':').map(Number);if(Number.isInteger(track)&&this.albums.get(slot)?.tracks[track])this.activate(slot,track); }
  playlistNames() { return [...this.albums.values()].map(a=>a.title); }
  catalog() { return [...this.albums.values()].flatMap(a=>a.tracks.map((t,i)=>({key:a.slot+':'+i,title:t.title,album:a.title,artist:t.artist||a.artist,number:i+1}))); }

  private async restore() {
    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('rhine-album-library', 1); r.onupgradeneeded = () => r.result.createObjectStore('albums', { keyPath: 'slot' }); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const albums = await new Promise<Album[]>((resolve, reject) => { const r = this.db!.transaction('albums').objectStore('albums').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      albums.filter(a => records[a.slot]).forEach(a => this.apply(a));
      const preferred=this.defaultCollection===undefined?undefined:this.albums.get(this.defaultCollection);
      const initial=preferred&&!preferred.demo&&preferred.tracks.length?preferred:[...this.albums.values()].find(a=>!a.demo&&a.tracks.length)??this.albums.get(0);
      if(initial){if(!initial.demo)this.setDefaultCollection(initial.slot);const visual=this.focusTrack(initial.slot,0);this.hooks.browse(visual);}
      this.paintRecords(); this.hooks.changed();
    } catch { this.hooks.notify('本地存储不可用；本次导入只能在当前页面使用。'); }
  }

  async showImport() {
    this.importer.open();
  }

  private async showLocalImport() {
    await this.ready;
    if (this.albums.size >= records.length) { this.hooks.notify('40 个专辑槽已满。'); return; }
    this.dialog.querySelector<HTMLFormElement>('form')!.reset();
    this.dialog.querySelector('.import-status')!.textContent = '';
    this.dialog.querySelector('.import-file-summary')!.textContent = '可多选，按文件名排序';
    this.dialog.showModal();
  }

  private async persist(a: Album) {
    if (this.db) await new Promise<void>((resolve, reject) => { const tx = this.db!.transaction('albums', 'readwrite'); tx.objectStore('albums').put(a); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  }
  private versionWriter(slot?:number,index=0){
    let collection=slot,primary=slot===undefined?undefined:this.albums.get(slot)?.tracks[index],extras=new Set<Track>();
    return async(versions:Track[])=>{await this.ready;if(!versions.length)return;
      const tracks=versions.map(t=>({...t}));
      if(collection===undefined){const next=records.findIndex((_,i)=>!this.albums.has(i));if(next<0)throw Error('歌单已满。');const a:Album={slot:next,title:tracks[0].title,artist:tracks[0].artist??'音源搜索',tracks};await this.persist(a);collection=next;primary=tracks[0];extras=new Set(tracks.slice(1));this.apply(a);this.activate(next);}
      else{const a=this.albums.get(collection);if(!a)throw Error('原歌单已不存在。');const remaining=a.tracks.filter(t=>!extras.has(t)),position=remaining.indexOf(primary!);if(position<0)throw Error('原曲目已变化，请重新查找音源。');remaining[position]=tracks[0];const updated={...a,tracks:[...remaining,...tracks.slice(1)]};await this.persist(updated);primary=tracks[0];extras=new Set(tracks.slice(1));this.apply(updated);this.hooks.changed();}
    };
  }
  private findTrack(index:number, slot=this.viewSlot()){
    const a=this.albums.get(slot),t=a?.tracks[index];if(!a||!t)return;
    this.importer.find((t.title+' '+(t.artist??a.artist)).slice(0,120),this.versionWriter(slot,index));
  }
  private viewSlot(){return this.currentCollection;}

  private async saveExternal(collection: { title: string; artist: string; tracks: Track[] }) {
    await this.ready;
    let slot = records.findIndex((_, i) => !this.albums.has(i));
    if (slot < 0) throw Error('40 个专辑槽已满。');
    if (!collection.tracks.length) throw Error('没有可以导入的曲目。');
    const a: Album = { slot, title: collection.title, artist: collection.artist, tracks: collection.tracks };
    await this.persist(a); this.apply(a); this.activate(slot);
    this.hooks.notify(this.db ? `已保存「${a.title}」· ${a.tracks.length} 首` : '本地存储不可用，此次导入仅在当前页面保留。');
  }

  private async bindFile(index: number) {
    const slot = this.currentCollection, a = this.albums.get(slot); if (!a?.tracks[index]) return;
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'audio/*,.mp3,.flac,.m4a,.wav,.ogg';
    input.addEventListener('change', async () => {
      const file = input.files?.[0]; if (!file) return;
      if (!file.type.startsWith('audio/') && !/\.(mp3|flac|m4a|wav|ogg|aac|opus)$/i.test(file.name)) { this.hooks.notify('请选择音频文件。'); return; }
      const metadata=await readLocalTrack(file,file.name);
      const updated = { ...a, tracks: a.tracks.map((t, i) => i === index ? { ...t, file, coverFile:metadata.coverFile??t.coverFile } : t) };
      try { await this.persist(updated); this.apply(updated); this.paintRecords(); this.hooks.changed(); this.hooks.notify('已绑定本地音频'); }
      catch { this.hooks.notify('音频保存失败，请检查浏览器存储空间。'); }
    }, { once: true }); input.click();
  }

  private async importFiles() {
    if (this.importing) return;
    const files = [...(this.dialog.querySelector<HTMLInputElement>('[name=tracks]')!.files ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
    if (!files.length) return;
    if (files.some(f => !f.type.startsWith('audio/') && !/\.(mp3|wav|flac|ogg|m4a|aac|opus|aiff|webm)$/i.test(f.name))) { this.dialog.querySelector('.import-status')!.textContent = '请选择受支持的音频文件。'; return; }
    let slot = this.hooks.selected();
    if (this.albums.has(slot)) slot = records.findIndex((_, i) => !this.albums.has(i));
    if (slot < 0) return;
    const cover = this.dialog.querySelector<HTMLInputElement>('[name=cover]')!.files?.[0];
    if (cover && (cover.size > 10 * 1048576 || !/^image\/(png|jpeg|webp)$/.test(cover.type))) { this.dialog.querySelector('.import-status')!.textContent = '封面需要是 10 MB 以内的 PNG、JPEG 或 WebP。'; return; }
    const a: Album = { slot, title: this.dialog.querySelector<HTMLInputElement>('[name=title]')!.value.trim() || '未命名专辑', artist: this.dialog.querySelector<HTMLInputElement>('[name=artist]')!.value.trim() || '未知艺术家', cover, tracks: files.map(file => ({ title: file.name.replace(/\.[^.]+$/, ''), file })) };
    this.importing = true;
    const submit = this.dialog.querySelector<HTMLButtonElement>('[type=submit]')!;
    submit.disabled = true;
    this.dialog.querySelector('.import-status')!.textContent = '正在读取歌曲标签和内嵌封面…';
    try {
      for(let i=0;i<files.length;i++){this.dialog.querySelector('.import-status')!.textContent='正在读取 '+(i+1)+' / '+files.length+' 首';a.tracks[i]=await readLocalTrack(files[i],files[i].name);}
      if (this.db) await new Promise<void>((resolve, reject) => { const tx = this.db!.transaction('albums', 'readwrite'); tx.objectStore('albums').put(a); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
      this.apply(a); this.dialog.close(); this.activate(slot); this.hooks.notify(this.db ? `已保存「${a.title}」· ${files.length} 首` : '已导入；关闭页面后需要重新选择文件');
    } catch { this.dialog.querySelector('.import-status')!.textContent = '保存失败，可能是存储空间不足。文件未加入音乐库，请减少文件后重试。'; }
    finally { this.importing = false; submit.disabled = false; }
  }

  panel(slot: number) {
    const a = this.albums.get(this.currentCollection);
    if (!a) return `<div class="album-empty"><span>NO RECORDING</span><h3>这张专辑，等你来录入。</h3><p>选择本地音频与封面，建立你的音乐档案。</p><button class="solid-button" data-player="import">＋ 导入专辑</button></div>`;
    const current = a.tracks[this.trackIndex(slot)];
    const displayTracks=this.sequence(a).map(i=>({t:a.tracks[i],i}));
    const cover = this.artwork(current,this.currentCollection);
    return `<div class="album-heading">${cover ? `<img class="album-cover" src="${esc(cover)}" alt="${esc(a.title)}封面">` : '<div class="album-cover album-cover-type" aria-hidden="true">RL.<small>AUDIO<br>ARCHIVE</small></div>'}<div><span>${a.demo ? 'DEMO / 示范专辑' : 'COLLECTION / 我的专辑'}</span><p>${esc(a.artist)}</p><button class="album-play-all" data-player="play-album">▶ 播放此歌曲</button></div><b>${String(a.tracks.length).padStart(2, '0')}<small>TRACKS</small></b></div><div class="album-tracks">${displayTracks.map(({t, i},position) => `<div class="track-row"><button class="album-track ${this.active === this.currentCollection && this.index === i ? 'is-current' : ''}" data-track="${i}" aria-label="播放 ${esc(t.title)}"><span>${String(position + 1).padStart(2, '0')}</span><strong>${esc(t.title)}${t.artist?`<small>${esc(t.artist)}</small>`:''}</strong><span>${this.active === this.currentCollection && this.index === i && !this.audio.paused ? 'Ⅱ' : '▷'}</span></button>${!t.file&&!t.url?`<button class="find-track" data-find-track="${i}" aria-label="为 ${esc(t.title)} 查找音源">找音源</button><button class="bind-track" data-bind-track="${i}" title="绑定本地音频" aria-label="为 ${esc(t.title)} 绑定本地音频">＋</button>${t.source?`<a class="track-source" href="${esc(t.source)}" target="_blank" rel="noopener" title="在原平台打开">↗</a>`:''}`:''}</div>`).join('')}</div>`;
  }

  info(slot: number) { const a = this.albums.get(this.currentCollection); return `<div class="panel-label">ALBUM NOTES / 专辑信息</div><p>${esc(records[slot].abstract)}</p><p>${a ? `${a.tracks.length} 首音频 · ${a.demo ? '内置示范专辑' : '保存在此设备的当前浏览器'}` : '尚未导入音频'}</p><p>空格播放／暂停。方向键浏览玻璃阵列，Enter 展开专辑，Esc 返回。清除浏览器站点数据会移除本地音乐库；请保留原始文件。</p>`; }
  log() { return `<div class="panel-label">LISTENING LOG / 本次播放</div>${this.history.length ? this.history.slice(-8).reverse().map(h => `<p>${esc(h)}</p>`).join('') : '<p>还没有播放记录。</p>'}`; }

  async play(slot: number, index: number) {
    const a = this.albums.get(slot), t = a?.tracks[index];
    if (!a || !t) { this.hooks.notify('这张专辑还没有音频，请先导入。'); return; }
    if(this.currentCollection!==slot||this.trackIndex(this.hooks.selected())!==index){
      const visual=this.focusTrack(slot,index);this.hooks.browse(visual);this.hooks.changed();
    }
    this.selectionChanged();
    const generation = ++this.generation;
    let resolved = t.url;
    if (!t.file && !resolved) {
      if (!t.remote) { this.findTrack(index, slot); return; }
      this.hooks.notify('正在检查平台音源…');
      try { const source = await localRequest('source', { remote: t.remote, quality: this.quality });if(generation!==this.generation)return;resolved=source.url;this.bar.querySelector('#actual-quality')!.textContent=source.quality??'平台音源'; }
      catch (e) { if (generation === this.generation) { const message=(e as Error).message;this.hooks.notify(message);if(!/联网权限|连接来源平台|本地助手|fetch failed/.test(message))this.findTrack(index, slot); } return; }
      if (generation !== this.generation) return;
    }
    this.audio.pause();this.seeking=false;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = t.file ? URL.createObjectURL(t.file) : undefined;
    this.active = slot; this.index = index;
    this.audio.src = this.objectUrl ?? resolved!;
    if(t.file||t.url)this.bar.querySelector('#actual-quality')!.textContent=t.quality??'原文件';
    this.bar.querySelector('#song-title')!.textContent = t.title;
    this.bar.querySelector('#song-artist')!.textContent = t.artist || a.artist;
    const cover = this.artwork(t,slot);
    this.bar.querySelector('.transport-art')!.setAttribute('aria-label','查看正在播放的歌曲：'+t.title);
    this.bar.querySelector('.transport-art')!.innerHTML = cover ? `<img src="${esc(cover)}" alt="">` : '<span>◎</span>';
    this.progress(); this.sync();
    try {
      await this.audio.play();
      if (generation !== this.generation) return;
      this.history.push(`${new Date().toLocaleTimeString('zh-CN')} · ${t.title}`);
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: a.artist, album: a.title });
    } catch (e) { if (generation === this.generation && (e as Error).name !== 'AbortError') this.hooks.notify('无法播放这首音频，请检查格式后重试。'); }
  }

  private async toggle() {
    if(this.audio.error&&this.active>=0){await this.play(this.active,this.index);return;}
    if (this.active < 0) { await this.play(this.currentCollection, this.trackIndex(this.hooks.selected())); return; }
    if (this.audio.paused) { try { await this.audio.play(); } catch { this.hooks.notify('播放失败，请重新选择曲目。'); } }
    else this.audio.pause();
  }

  private next(direction: number, ended = false) {
    const slot=this.active>=0?this.active:this.currentCollection;
    const index=this.active>=0?this.index:this.trackIndex(this.hooks.selected());
    const a = this.albums.get(slot);
    if (!a) return;
    if (ended && this.repeat === 2) { void this.play(this.active, this.index); return; }
    if (direction < 0 && this.audio.currentTime > 3) { this.audio.currentTime = 0; return; }
    const sequence=this.sequence(a);
    let n = sequence.indexOf(index) + direction;
    if (ended && n >= a.tracks.length && !this.repeat) { this.sync(); return; }
    n = (n + a.tracks.length) % a.tracks.length;
    void this.play(slot, sequence[n]);
  }

  private progress() {
    const seek = this.bar.querySelector<HTMLInputElement>('#song-seek')!;
    const valid = Number.isFinite(this.audio.duration) && this.audio.duration > 0;
    seek.disabled = !valid;
    if (!this.seeking) { seek.value = String(valid ? this.audio.currentTime / this.audio.duration * 1000 : 0); this.bar.querySelector('#song-time')!.textContent = clock(this.audio.currentTime); }
    this.bar.querySelector('#song-duration')!.textContent = clock(this.audio.duration);
    seek.setAttribute('aria-valuetext', `${clock(this.audio.currentTime)} / ${clock(this.audio.duration)}`);
  }

  private sync() {
    const playing = !this.audio.paused && !this.audio.ended && !this.audio.error;
    this.hooks.suppress(playing);
    this.bar.classList.toggle('is-playing', playing);
    const toggle = this.bar.querySelector('[data-player=toggle]')!;
    toggle.textContent = playing ? 'Ⅱ' : '▶'; toggle.setAttribute('aria-label', playing ? '暂停' : '播放');
    document.querySelectorAll<HTMLElement>('[data-player=play-album]').forEach(b=>{b.textContent=playing&&this.isSelectedPlaying()?'Ⅱ 暂停此歌曲':'▶ 播放此歌曲';});
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    document.querySelectorAll<HTMLElement>('[data-track]').forEach(b => { const current = this.active === this.currentCollection && Number(b.dataset.track) === this.index; b.classList.toggle('is-current', current); b.lastElementChild!.textContent = current && playing ? 'Ⅱ' : '▷'; });
  }
}
