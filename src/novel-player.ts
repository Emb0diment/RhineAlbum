import { parseNovel, speechParts, type Novel } from './novel-parser';
import { escapeHtml as esc } from './html';
import './novel-player.css';

export class NovelPlayer {
  private dialog = document.createElement('dialog');
  private books = new Map<string, Novel>();
  private book?: Novel;
  private db?: IDBDatabase;
  private parts: string[] = [];
  private speaking = false;
  private token = 0;
  private voice = '';
  private rate = 1;
  private loading = false;
  private ready: Promise<void>;
  constructor(private music: HTMLAudioElement, private notify: (text: string) => void) {
    this.dialog.className = 'novel-reader';
    this.dialog.innerHTML = `<header><span>READ / 小说朗读</span><button data-read="close" aria-label="关闭小说">×</button></header><div class="reader-library"><label class="reader-import">＋ 导入 TXT / EPUB<input type="file" accept=".txt,.epub" hidden></label><select id="reader-book" aria-label="选择小说"><option>书架为空</option></select></div><h2>把文字，交给声音。</h2><div class="reader-options"><select id="reader-chapter" aria-label="章节"><option>请选择小说</option></select><select id="reader-voice" aria-label="朗读声音"></select><label>语速 <select id="reader-rate" aria-label="朗读语速"><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label></div><article class="reader-text" tabindex="0">导入小说后自动整理章节。点击段落可从该处开始朗读，阅读进度会保存在本机。</article><footer><button data-read="prev">← 上一章</button><button data-read="play">▶ 开始朗读</button><button data-read="next">下一章 →</button><span class="reader-progress"></span></footer><p class="reader-status" role="status"></p>`;
    document.body.append(this.dialog);
    const button = document.createElement('button'); button.dataset.player = 'novel'; button.textContent = '小说'; button.title = 'TXT / EPUB 小说朗读';
    document.querySelector('.system-nav')!.prepend(button);
    button.addEventListener('click', () => { void this.open(); });
    this.dialog.addEventListener('click', e => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-read],[data-paragraph]'); if (!target) return;
      if (target.dataset.paragraph !== undefined && this.book) { this.stop(); this.book.paragraph = Number(target.dataset.paragraph); this.read(); return; }
      if (target.dataset.read === 'close') this.dialog.close();
      if (target.dataset.read === 'play') { if (this.speaking) this.stop(); else this.read(); }
      if (target.dataset.read === 'prev') this.chapter(-1);
      if (target.dataset.read === 'next') this.chapter(1);
    });
    this.dialog.addEventListener('close', () => this.stop());
    this.dialog.querySelector<HTMLInputElement>('input')!.addEventListener('change', e => { const input=e.target as HTMLInputElement; if(input.files?.[0])void this.import(input.files[0]); });
    this.dialog.querySelector('#reader-book')!.addEventListener('change', e => { this.stop(); this.book = this.books.get((e.target as HTMLSelectElement).value); this.render(); });
    this.dialog.querySelector('#reader-chapter')!.addEventListener('change', e => { if (!this.book) return; this.stop(); this.book.chapter = Number((e.target as HTMLSelectElement).value); this.book.paragraph = 0; this.render(); void this.save(); });
    for (const id of ['reader-rate','reader-voice']) this.dialog.querySelector('#' + id)!.addEventListener('change', e => { const resume=this.speaking;this.stop();if(id==='reader-rate')this.rate=Number((e.target as HTMLSelectElement).value);else this.voice=(e.target as HTMLSelectElement).value;if(resume)this.read(); });
    if ('speechSynthesis' in window) { speechSynthesis.addEventListener('voiceschanged', () => this.voices()); this.voices(); }
    else this.status('当前浏览器不支持朗读，仍可阅读文字。');
    music.addEventListener('play', () => this.stop());
    this.ready = this.restore();
  }
  private status(text: string) { this.dialog.querySelector('.reader-status')!.textContent = text; }
  private voices() {
    const voices = speechSynthesis.getVoices().filter(v=>v.localService).sort((a,b)=>Number(/^zh/.test(b.lang))-Number(/^zh/.test(a.lang)));
    const select=this.dialog.querySelector<HTMLSelectElement>('#reader-voice')!;
    select.innerHTML=voices.length?voices.map(v=>`<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`).join(''):'<option value="">没有可用的本机声音</option>';
    if(voices.some(v=>v.voiceURI===this.voice))select.value=this.voice;this.voice=select.value;
  }
  private async open() { await this.ready;this.render();this.dialog.showModal();this.voices(); }
  private async restore() {
    try {
      this.db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('rhine-novel-library',1);r.onupgradeneeded=()=>r.result.createObjectStore('books',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const books=await new Promise<Novel[]>((resolve,reject)=>{const r=this.db!.transaction('books').objectStore('books').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      books.forEach(b=>{try{const p=JSON.parse(localStorage.getItem('rhine-reading-'+b.id)??'null');if(p&&Number.isInteger(p.chapter)&&p.chapter>=0&&p.chapter<b.chapters.length){b.chapter=p.chapter;b.paragraph=Math.max(0,Number(p.paragraph)||0);}}catch{}this.books.set(b.id,b);});this.book=this.books.get(localStorage.getItem('rhine-last-book')??'')??books[0];
    } catch { this.status('书架存储不可用，此次阅读仅在当前页面保留。'); }
  }
  private async save(storeText=false) {
    if(!this.book)return;
    try{localStorage.setItem('rhine-last-book',this.book.id);localStorage.setItem('rhine-reading-'+this.book.id,JSON.stringify({chapter:this.book.chapter,paragraph:this.book.paragraph}));}catch{this.status('阅读位置暂时无法保存。');}
    if(!storeText||!this.db)return;
    try { await new Promise<void>((resolve,reject)=>{const tx=this.db!.transaction('books','readwrite');tx.objectStore('books').put(this.book!);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);}); }
    catch { this.status('阅读进度保存失败，请检查浏览器存储空间。'); }
  }
  private async import(file: File) {
    if(this.loading)return;this.loading=true;this.stop();this.status('正在整理章节…');
    try { const book=await parseNovel(file);this.books.set(book.id,book);this.book=book;await this.save(true);this.render();this.status(`已导入 ${book.chapters.length} 章，可开始朗读。`); }
    catch(e){this.status((e as Error).message);}finally{this.loading=false;this.dialog.querySelector<HTMLInputElement>('input')!.value='';}
  }
  private render() {
    if(!this.book)return;const b=this.book;
    this.dialog.querySelector('h2')!.textContent=b.title;
    this.dialog.querySelector('#reader-book')!.innerHTML=[...this.books.values()].map(a=>`<option value="${a.id}" ${a.id===b.id?'selected':''}>${esc(a.title)}</option>`).join('');
    this.dialog.querySelector('#reader-chapter')!.innerHTML=b.chapters.map((c,i)=>`<option value="${i}" ${i===b.chapter?'selected':''}>${esc(c.title)}</option>`).join('');
    this.parts=speechParts(b.chapters[b.chapter].text);b.paragraph=Math.min(b.paragraph,Math.max(0,this.parts.length-1));
    this.dialog.querySelector('.reader-text')!.innerHTML=this.parts.map((p,i)=>`<button data-paragraph="${i}">${esc(p)}</button>`).join('');this.progress();
  }
  private progress() {
    if(!this.book)return;
    this.dialog.querySelectorAll('[data-paragraph].is-current').forEach(e=>e.classList.remove('is-current'));
    const current=this.dialog.querySelector<HTMLElement>(`[data-paragraph="${this.book.paragraph}"]`);current?.classList.add('is-current');current?.scrollIntoView({block:'nearest'});
    this.dialog.querySelector('.reader-progress')!.textContent=`${this.book.chapter+1} / ${this.book.chapters.length} 章 · ${this.book.paragraph+1} / ${this.parts.length} 段`;
    this.dialog.querySelector('[data-read=play]')!.textContent=this.speaking?'Ⅱ 暂停朗读':'▶ 继续朗读';
  }
  private stop() { this.token++;this.speaking=false;if('speechSynthesis'in window)speechSynthesis.cancel();this.progress();void this.save(); }
  private chapter(direction: number) { if(!this.book)return;const resume=this.speaking;this.stop();this.book.chapter=Math.max(0,Math.min(this.book.chapters.length-1,this.book.chapter+direction));this.book.paragraph=0;this.render();void this.save();if(resume)this.read(); }
  private read() {
    if(!this.book)return;
    if(!('speechSynthesis'in window)||!speechSynthesis.getVoices().some(v=>v.localService&&v.voiceURI===this.voice)){this.status('没有可用的本机朗读声音。请在 Windows 语言设置中添加语音包后重新打开播放器。');return;}
    this.music.pause();this.speaking=true;const token=++this.token;this.status('正在朗读 · 关闭窗口会暂停并记住位置。');
    const next=()=>{
      if(token!==this.token||!this.speaking||!this.book)return;
      const b=this.book;
      if(b.paragraph>=this.parts.length){if(b.chapter+1>=b.chapters.length){b.paragraph=Math.max(0,this.parts.length-1);this.stop();this.status('已读完全书。');return;}b.chapter++;b.paragraph=0;this.render();}
      const utterance=new SpeechSynthesisUtterance(this.parts[b.paragraph]);utterance.voice=speechSynthesis.getVoices().find(v=>v.voiceURI===this.voice&&v.localService)??null;utterance.lang=utterance.voice?.lang??'zh-CN';utterance.rate=this.rate;
      utterance.onend=()=>{if(token!==this.token)return;b.paragraph++;void this.save();next();};
      utterance.onerror=e=>{if(token!==this.token)return;this.stop();this.status(e.error==='synthesis-failed'||e.error==='voice-unavailable'?'系统未能启用所选语音。请尝试其他声音，或在 Windows 语言设置中修复语音包后重试。':'朗读未能继续：'+e.error);};
      this.progress();speechSynthesis.speak(utterance);
    };next();
  }
}
