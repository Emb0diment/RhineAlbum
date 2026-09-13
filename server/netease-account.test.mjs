import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createLogin,checkLogin,accountStatus,accountPlaylists,logout,neteaseCookie} from './netease-account.mjs';
test('QR authorization remains on the helper and logout clears it',async()=>{
  const real=globalThis.fetch;let mode=801;const calls=[];
  globalThis.fetch=async(url,options)=>{const u=new URL(url);calls.push({path:u.pathname,cookie:options.headers.Cookie});let data;const headers={};
    if(u.pathname.endsWith('/unikey'))data={code:200,unikey:'test-key'};
    else if(u.pathname.endsWith('/client/login')){data={code:mode};if(mode===803)headers['set-cookie']='MUSIC_U=test-session; HttpOnly; Path=/';}
    else if(u.pathname.endsWith('/account/get'))data={code:200,profile:{userId:123,nickname:'测试用户'}};
    else if(u.pathname.endsWith('/user/playlist'))data={code:200,playlist:[{id:1,name:'我的歌单',creator:{userId:123},trackCount:4}],more:false};
    else throw Error('Unexpected request');return new Response(JSON.stringify(data),{headers});};
  try{logout();const login=await createLogin();assert.equal((await checkLogin(login.ticket)).state,'waiting');mode=803;const authorized=await checkLogin(login.ticket);assert.equal(authorized.loggedIn,true);assert.equal('cookie'in authorized,false);assert.equal(neteaseCookie(),'MUSIC_U=test-session');assert.equal((await accountPlaylists()).playlists[0].owned,true);assert.equal(calls.at(-1).cookie,'MUSIC_U=test-session');logout();assert.equal(neteaseCookie(),'');assert.deepEqual(await accountStatus(),{loggedIn:false});assert.equal((await checkLogin(login.ticket)).state,'expired');}
  finally{logout();globalThis.fetch=real;}
});
