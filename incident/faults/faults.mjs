#!/usr/bin/env node
// Fault injection for the IncidentAgent benchmark lab.
//
//   node faults.mjs list
//   node faults.mjs inject F2          apply a code fault and commit it
//   node faults.mjs show  F2          print the diff the fault introduces
//   node faults.mjs revert            undo the last fault commit
//
// Code faults are exact-string edits on the target service, committed so the
// read-only `git log` / `git diff` channels have real history to reason about.
// Runtime faults change an environment variable only and never commit -- those
// exist to test whether the agent correctly skips the deployment/git steps.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SERVICE = process.env.TARGET_SERVICE_DIR ??
  new URL('../workspace/target-service/', import.meta.url).pathname;

const FAULTS = [
  {
    id: 'F2',
    kind: 'code',
    title: 'unchecked downstream call raises NPE',
    file: 'src/main/java/com/example/target/OrderService.java',
    find: `        if (profile == null) {
            order.put("ship_to", "UNKNOWN");
        } else {
            order.put("ship_to", profile.get("address"));
        }`,
    replace: `        order.put("ship_to", profile.get("address"));`,
    commit: 'feat(order): enrich response with downstream shipping address',
  },
  {
    id: 'F4',
    kind: 'runtime',
    title: 'downstream read timeout shrunk to 50ms',
    env: { DOWNSTREAM_TIMEOUT_MS: '50' },
    commit: null,
  },
  {
    id: 'F5',
    kind: 'runtime',
    title: 'Hikari maximum-pool-size reduced to 2',
    env: { DB_POOL_SIZE: '2' },
    commit: null,
  },
];

const byId = (id) => FAULTS.find((f) => f.id === id);

function git(...argv) {
  return execFileSync('git', argv, { cwd: SERVICE, encoding: 'utf8' }).trim();
}

function gitRoot(...argv) {
  return execFileSync('git', argv, { cwd: SERVICE, encoding: 'utf8', maxBuffer: 16 << 20 });
}

const cmd = process.argv[2];
const id = process.argv[3];

switch (cmd) {
  case 'list':
    for (const f of FAULTS) {
      process.stdout.write(`${f.id}  [${f.kind.padEnd(7)}] ${f.title}\n`);
    }
    break;

  case 'show': {
    const fault = byId(id);
    if (!fault) die(`unknown fault ${id}`);
    if (fault.kind !== 'code') die(`${id} is a runtime fault; nothing to show in git`);
    const current = readFileSync(join(SERVICE, fault.file), 'utf8');
    if (!current.includes(fault.find)) die(`${id} is already injected; nothing left to show`);
    process.stdout.write(`--- a/${fault.file}\n+++ b/${fault.file}\n`);
    process.stdout.write(`-${fault.find.replace(/\n/g, '\n-')}\n+${fault.replace}\n`);
    break;
  }

  case 'inject': {
    const fault = byId(id);
    if (!fault) die(`unknown fault ${id}`);

    if (fault.kind === 'runtime') {
      process.stdout.write(
        `runtime fault ${id}: set ${JSON.stringify(fault.env)} on the target-service container,\n` +
          'then run:  docker compose up -d --force-recreate target-service\n' +
          'no commit is created -- that is the point of this fault class.\n',
      );
      break;
    }

    const path = join(SERVICE, fault.file);
    const current = readFileSync(path, 'utf8');
    if (!current.includes(fault.find)) {
      die(`cannot inject ${id}: baseline text not found in ${fault.file} (already injected?)`);
    }

    writeFileSync(path, current.replace(fault.find, fault.replace));
    gitRoot('add', fault.file);
    // The commit message is what the read-only `git` channel shows the agent.
    // A body like "Fault-F2: unchecked downstream call raises NPE" hands over
    // the ground truth, so the message stays a plain feature subject.
    gitRoot('commit', '-m', fault.commit);
    process.stdout.write(`${id} injected and committed at ${git('rev-parse', '--short', 'HEAD')}\n`);
    process.stdout.write('now rebuild and redeploy:  docker compose up -d --build --force-recreate target-service\n');
    break;
  }

  case 'revert': {
    const head = git('log', '-1', '--pretty=%s');
    if (head !== byId(id)?.commit) die(`HEAD is not the ${id} commit: ${head}`);
    gitRoot('revert', '--no-edit', 'HEAD');
    process.stdout.write(`reverted ${id ?? head}\n`);
    break;
  }

  default:
    process.stderr.write('usage: faults.mjs <list|show|inject|revert> [faultId]\n');
    process.exit(1);
}

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}