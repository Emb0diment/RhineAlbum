import {build} from 'vite';
import fs from 'node:fs';
import path from 'node:path';
await build({configFile:false,build:{lib:{entry:'node_modules/music-metadata/lib/core.js',formats:['es'],fileName:()=> 'metadata.js'},outDir:'src/vendor/metadata',emptyOutDir:false,minify:false}});
const seen=new Set();fs.mkdirSync('public/licenses',{recursive:true});
function licenses(name){if(seen.has(name))return;seen.add(name);const dir=path.join('node_modules',name),p=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));for(const file of fs.readdirSync(dir).filter(f=>/^licen[sc]e(?:\.|$)/i.test(f))){if(fs.statSync(path.join(dir,file)).isFile())fs.copyFileSync(path.join(dir,file),path.join('public/licenses',name.replaceAll('/','-')+'-'+file));}for(const dep of Object.keys(p.dependencies??{}))licenses(dep);}
licenses('music-metadata');licenses('qrcode');
