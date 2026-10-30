import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { default: WebSocket } = await import(`${ROOT}/node_modules/ws/index.js`);
const cookie = fs.readFileSync('/tmp/mc-cookie.txt','utf8').trim();
const chatJid = process.argv[2];
const content = fs.readFileSync(process.argv[3],'utf8');
const ws = new WebSocket('ws://127.0.0.1:3000/ws', { headers:{ Cookie: cookie } });
const seen = new Map();
ws.on('open', ()=>ws.send(JSON.stringify({type:'send_message', chatJid, content})));
ws.on('message', r=>{
  let m; try { m = JSON.parse(r.toString()); } catch { return; }
  seen.set(m.type, (seen.get(m.type)??0)+1);
  if (m.type === 'status_update') return;
  console.log('[evt]', m.type, JSON.stringify(m).slice(0,220));
});
ws.on('error', e=>console.log('ERR', e.message));
const t = setTimeout(()=>{ console.log('--- event types seen ---'); console.log([...seen]); process.exit(0); }, 150000);
ws.on('close', ()=>{ console.log('--- event types seen ---'); console.log([...seen]); process.exit(0); });
