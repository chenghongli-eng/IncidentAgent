// Constructs a local admin session cookie for the Miniclaw API.
// Neither the token nor the signature is ever printed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/persistent/home/fs-user/IdeaProjects/ai_coding/study/miniclaw-main/miniclaw-main/');
const Database = require('better-sqlite3');

const ROOT = '/persistent/home/fs-user/IdeaProjects/ai_coding/study/miniclaw-main/miniclaw-main';
const secret = fs.readFileSync(`${ROOT}/data/config/session-secret.key`, 'utf8').trim();
const db = new Database(`${ROOT}/data/db/messages.db`, { readonly: true });
const row = db
  .prepare(`SELECT s.id, s.expires_at, u.role FROM user_sessions s JOIN users u ON u.id = s.user_id
            WHERE s.expires_at > ? ORDER BY s.last_active_at DESC LIMIT 1`)
  .get(new Date().toISOString());
db.close();
if (!row) { console.error('no live session'); process.exit(1); }
const sig = crypto.createHmac('sha256', secret).update(row.id).digest('hex');
process.stderr.write(`session found (role=${row.role}, expires=${row.expires_at})\n`);
process.stdout.write(`miniclaw_session=${row.id}.${sig}`);
