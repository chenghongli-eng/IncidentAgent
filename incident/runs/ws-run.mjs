import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { default: WebSocket } = await import(`${ROOT}/node_modules/ws/index.js`);
const cookie = fs.readFileSync('/tmp/mc-cookie.txt','utf8').trim();
const chatJid = process.argv[2];
const content = fs.readFileSync(process.argv[3],'utf8');
// 上限是安全网，不是节奏控制。2026-10-30 的 F2 轮 Agent 跑了 15 分 10 秒，
// 而 cap 是 15 分钟——runner 在报告送达前 10 秒断开，那一轮的采集口径就废了。
// 15 分钟是 F4 轮的耗时（4.5 分钟）外推出来的，对 F2 不成立。
const capMs = Number(process.argv[4] ?? 1800000);
const ws = new WebSocket('ws://127.0.0.1:3000/ws', { headers:{ Cookie: cookie } });
let out='', last=Date.now(), done=false;
function finish(reason){
  if(done)return; done=true; clearTimeout(cap);
  if (!out) process.stderr.write(`no agent_reply (${reason})\n`);
  fs.writeFileSync('/tmp/agent-out.txt', out);
  process.stdout.write(out + '\n'); process.exit(0);
}
const cap = setTimeout(()=>{ process.stderr.write('cap reached -> stop\n'); finish('cap'); }, capMs);
ws.on('open', ()=>ws.send(JSON.stringify({type:'send_message', chatJid, content})));
ws.on('message', r=>{
  last=Date.now();
  let m; try{ m=JSON.parse(r.toString()); }catch{return;}
  if (m.type==='agent_reply' && m.text) out += (m.text.trim().startsWith('#')?'\n\n---\n\n':'') + m.text + '\n';
  if (m.type==='error') process.stderr.write(`ERR ${m.error??m.message}\n`);
  if (m.type==='run_finished'){ process.stderr.write(`run_finished reason=${m.reason}\n`); setTimeout(()=>finish('run_finished'),3000); }
});
ws.on('error', e=>{ process.stderr.write('socket '+e.message+'\n'); finish('socket error'); });
// 空闲看门狗：WS 上一直有 status_update，所以「没消息」只说明客户端没收到事件。
// 真挂死的判据是「Agent 那边也没动静」——这里保守用 10 分钟，够长，
// 又不会让一轮在真挂死时无限等下去。
setInterval(()=>{ if(Date.now()-last>600000){ process.stderr.write('idle 10min -> stop\n'); finish('idle'); } },5000);
