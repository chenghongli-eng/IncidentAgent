import WebSocket from '/persistent/home/fs-user/IdeaProjects/ai_coding/study/miniclaw-main/miniclaw-main/node_modules/ws/index.js';
import fs from 'node:fs';
const cookie = fs.readFileSync('/tmp/mc-cookie.txt','utf8').trim();
const chatJid = process.argv[2];
const content = fs.readFileSync(process.argv[3],'utf8');
const capMs = Number(process.argv[4] ?? 900000);
const ws = new WebSocket('ws://127.0.0.1:3000/ws', { headers:{ Cookie: cookie } });
let out='', last=Date.now(), done=false;
function finish(){ if(done)return; done=true; clearTimeout(cap);
  fs.writeFileSync('/tmp/agent-out.txt', out);
  process.stdout.write(out + '\n'); process.exit(0); }
const cap = setTimeout(finish, capMs);
ws.on('open', ()=>ws.send(JSON.stringify({type:'send_message', chatJid, content})));
ws.on('message', r=>{
  last=Date.now();
  let m; try{ m=JSON.parse(r.toString()); }catch{return;}
  if (m.type==='agent_reply' && m.text) out += (m.text.trim().startsWith('#')?'\n\n---\n\n':'') + m.text + '\n';
  if (m.type==='error') process.stderr.write(`ERR ${m.error??m.message}\n`);
  if (m.type==='run_finished'){ process.stderr.write(`run_finished reason=${m.reason}\n`); setTimeout(finish,3000); }
});
ws.on('error', e=>{ process.stderr.write('socket '+e.message+'\n'); finish(); });
setInterval(()=>{ if(Date.now()-last>240000){ process.stderr.write('idle 4min -> stop\n'); finish(); } },5000);
