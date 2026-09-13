import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './server/api.mjs';
const root = path.resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.glb':'model/gltf-binary','.ogg':'audio/ogg','.mp3':'audio/mpeg','.json':'application/json','.webmanifest':'application/manifest+json','.pdf':'application/pdf' };
const server = http.createServer(async (req,res)=>{
 if(await api(req,res))return;
 let filename;
 try { filename=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname)); } catch { res.writeHead(400).end();return; }
 if(filename!==root && !filename.startsWith(root.endsWith(path.sep)?root:root+path.sep)){res.writeHead(403).end();return;}
 if(filename===root || filename===root.slice(0,-1))filename=path.join(root,'index.html');
 fs.stat(filename,(error,stat)=>{
  if(error||!stat.isFile()){res.writeHead(404).end('Not found');return;}
  const headers={'Content-Type':mime[path.extname(filename)]??'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'no-cache'};
  const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if(range){const start=Number(range[1]),end=Math.min(range[2]?Number(range[2]):stat.size-1,stat.size-1);if(start>end||start>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}).end();return;}res.writeHead(206,{...headers,'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${stat.size}`});fs.createReadStream(filename,{start,end}).pipe(res);}
  else{res.writeHead(200,{...headers,'Content-Length':stat.size});if(req.method==='HEAD')res.end();else fs.createReadStream(filename).pipe(res);}
 });
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Port 5174 is already in use. Open http://127.0.0.1:5174/ if the player is already running.':error);process.exitCode=1});
server.listen(5174,'127.0.0.1',()=>console.log('Rhine Album: http://127.0.0.1:5174/  (Ctrl+C to stop)'));
