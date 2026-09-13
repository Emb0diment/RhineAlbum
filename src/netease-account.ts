import {localRequest} from './source-import';
import {escapeHtml as esc} from './html';
import type {Track} from './album-player';
export class NeteaseAccount {
  private dialog=document.createElement('dialog');
  private generation=0;
  private timer=0;
  private busy=false;
  private offset=0;
  constructor(private save:(album:{title:string;artist:string;tracks:Track[]})=>Promise<void>){
    this.dialog.className='album-import netease-account';
    this.dialog.innerHTML='<header><span>NETEASE / 网易云账号</span><button data-account="close" aria-label="关闭">×</button></header><h2>连接你的音乐收藏。</h2><div class="account-content"></div><p class="account-status" role="status" aria-live="polite"></p>';
    document.body.append(this.dialog);
    this.dialog.addEventListener('close',()=>{this.generation++;clearTimeout(this.timer);});
    this.dialog.addEventListener('cancel',e=>{if(this.busy)e.preventDefault();});
    this.dialog.addEventListener('click',e=>{const button=(e.target as HTMLElement).closest<HTMLElement>('[data-account]');if(!button||this.busy)return;const action=button.dataset.account;
      if(action==='close')this.dialog.close();
      if(action==='login')void this.login();
      if(action==='logout')void this.run(async()=>{await localRequest('netease/logout',{});this.loggedOut();this.status('已断开账号，本机助手已清除登录凭据。');});
      if(action==='more')void this.run(()=>this.playlists(this.offset+100));
      if(action==='import')void this.run(async()=>{this.status('正在读取歌单和歌曲封面…');const collection=await localRequest('playlist',{link:'https://music.163.com/playlist?id='+button.dataset.id});await this.save(collection);this.dialog.close();});
    });
  }
  private status(text:string){this.dialog.querySelector('.account-status')!.textContent=text;}
  private get content(){return this.dialog.querySelector('.account-content')!;}
  private async run(fn:()=>Promise<void>){this.busy=true;this.dialog.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){this.status((e as Error).message);}finally{this.busy=false;this.dialog.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=false);}}
  async open(){this.dialog.showModal();this.content.textContent='正在检查登录状态…';await this.run(async()=>{const result=await localRequest('netease/status');if(result.loggedIn)await this.connected(result.profile.nickname);else this.loggedOut();});}
  private loggedOut(){this.generation++;clearTimeout(this.timer);this.content.innerHTML='<p>用网易云音乐 App 扫码，在手机上确认登录后获取你的歌单。无需在播放器输入密码。</p><p>登录凭据仅保留在本机助手内存，关闭助手或断开账号后清除。使用网易云网页接口，平台变更可能影响连接。</p><button class="solid-button source-primary" data-account="login">生成登录二维码 →</button>';}
  private async login(){await this.run(async()=>{
    const generation=++this.generation;clearTimeout(this.timer);this.status('正在生成二维码…');
    const result=await localRequest('netease/login',{});const {default:QR}=await import('./vendor/qrcode.js');const image=await QR.toDataURL(result.url,{width:256,margin:2,errorCorrectionLevel:'M'});
    if(generation!==this.generation||!this.dialog.open)return;
    this.content.innerHTML=`<div class="account-qr"><img src="${esc(image)}" alt="使用网易云 App 扫描登录二维码"><p>打开网易云音乐 App 扫一扫<br>并在手机上确认登录</p></div><button class="source-primary" data-account="login">刷新二维码 ↻</button>`;
    this.status('等待扫码 · 二维码约 3 分钟失效');
    const poll=async()=>{if(generation!==this.generation||!this.dialog.open)return;try{const state=await localRequest('netease/check',{ticket:result.ticket});if(generation!==this.generation||!this.dialog.open)return;if(state.state==='authorized'){await this.run(()=>this.connected(state.profile.nickname));return;}if(state.state==='expired'){this.status('二维码已失效，请点击刷新。');return;}this.status(state.state==='confirm'?'已扫码，请在网易云 App 上确认登录。':'等待网易云 App 扫码…');this.timer=window.setTimeout(poll,2200);}catch(e){if(generation===this.generation)this.status((e as Error).message+' 请刷新二维码重试。');}};
    this.timer=window.setTimeout(poll,2200);
  });}
  private async connected(nickname:string){this.generation++;clearTimeout(this.timer);this.content.innerHTML=`<div class="source-summary"><strong>${esc(nickname)}</strong><span>账号已连接 · 登录仅保留到本机助手关闭</span><button data-account="logout">断开账号</button></div><div class="account-playlists"></div>`;await this.playlists(0);this.status('选择歌单导入。播放时按账号权限获取完整音源和所选音质。');}
  private async playlists(offset:number){const result=await localRequest('netease/playlists',{offset});this.offset=offset;const list=this.content.querySelector('.account-playlists')!;this.content.querySelector('[data-account=more]')?.remove();if(!offset)list.innerHTML='';list.insertAdjacentHTML('beforeend',result.playlists.map((p:{id:string;title:string;count:number;owned:boolean})=>`<button class="account-playlist" data-account="import" data-id="${esc(p.id)}"><strong>${esc(p.title)}</strong><span>${p.owned?'我创建的':'我收藏的'} · ${p.count} 首　导入 ＋</span></button>`).join(''));if(result.more)list.insertAdjacentHTML('afterend','<button class="source-primary" data-account="more">加载更多歌单 ↓</button>');if(!result.playlists.length&&!offset)list.textContent='账号没有返回歌单。';}
}
