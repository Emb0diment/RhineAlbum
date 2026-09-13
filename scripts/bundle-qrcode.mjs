import {build} from 'vite';
import {copyFileSync,mkdirSync} from 'node:fs';
await build({configFile:false,build:{lib:{entry:'node_modules/qrcode/lib/browser.js',formats:['es'],fileName:()=> 'qrcode.js'},outDir:'src/vendor',emptyOutDir:false,minify:false}});
mkdirSync('public/licenses',{recursive:true});
copyFileSync('node_modules/qrcode/license','public/licenses/qrcode-MIT.txt');
