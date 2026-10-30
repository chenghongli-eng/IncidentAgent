#!/usr/bin/env node
// Fault injection for the IncidentAgent benchmark lab.
//
//   node faults.mjs list
//   node faults.mjs inject F2          apply a code fault and commit it
//   node faults.mjs restore F2         undo a code fault and commit the undo
//   node faults.mjs show  F2          print the diff the fault introduces
//   node faults.mjs revert            undo the last fault commit
//
// Code faults are exact-string edits on the target service, committed so the
// read-only `git log` / `git diff` channels have real history to reason about.
// Runtime faults change an environment variable only and never commit -- those
// exist to test whether the agent correctly skips the deployment/git steps.
//
// inject / restore 是一对可逆操作，两个方向都提交：
//   inject  = 把判空兜底删掉（缺陷上线）
//   restore = 把判空兜底加回来（缺陷下线）
// 「发布即触发」类故障（F2）必须靠这对操作把「缺陷一直在线」和
// 「一次发布把缺陷带上去」区分开，否则测出来的是配置归因而不是发布归因。

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
    restoreCommit: 'fix(order): tolerate missing downstream profile',
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
          'then run:  ./lab.sh recreate target-service\n' +
          'no commit is created -- that is the point of this fault class.\n',
      );
      break;
    }

    const path = join(SERVICE, fault.file);
    const current = readFileSync(path, 'utf8');
    if (!current.includes(fault.find)) {
      die(`cannot inject ${id}: baseline text not found in ${fault.file} (already injected? run \`faults.mjs restore ${id}\` first)`);
    }

    writeFileSync(path, current.replace(fault.find, fault.replace));
    gitRoot('add', fault.file);
    // The commit message is what the read-only `git` channel shows the agent.
    // A body like "Fault-F2: unchecked downstream call raises NPE" hands over
    // the ground truth, so the message stays a plain feature subject.
    gitRoot('commit', '-m', fault.commit);
    process.stdout.write(`${id} injected and committed at ${git('rev-parse', '--short', 'HEAD')}\n`);
    process.stdout.write('now rebuild and redeploy:  ./lab.sh build target-service\n');
    break;
  }

  case 'revert': {
    const head = git('log', '-1', '--pretty=%s');
    if (head !== byId(id)?.commit) die(`HEAD is not the ${id} commit: ${head}`);
    gitRoot('revert', '--no-edit', 'HEAD');
    process.stdout.write(`reverted ${id ?? head}\n`);
    break;
  }

  /**
   * 把 F2 缺陷撤回去，并**提交**。
   *
   * 为什么要有「撤回去」这一步：F2 这类「发布即触发」的故障，Agent 看到的必须是
   * 「一次发布把缺陷带上去了」，而不是「缺陷一直都在，只是压测路径变了」。
   * 后者会让 Agent 合理地把触发源归到配置上——那测的就不是发布归因了。
   *
   * 提交而不是直接改文件：Agent 的证据通道是 git log / git diff，
   * 工作区与 HEAD 不一致时它读到的是另一个版本的真相，那一轮就废了。
   *
   * 提交信息用一句普通的修复说明，不带故障编号、不描述机制。
   */
  case 'restore': {
    const fault = byId(id);
    if (!fault) die(`unknown fault ${id}`);
    if (fault.kind !== 'code') die(`${id} is a runtime fault; there is nothing in git to restore`);

    const path = join(SERVICE, fault.file);
    const current = readFileSync(path, 'utf8');
    if (current.includes(fault.find)) {
      process.stdout.write(`${id} is not injected; nothing to restore\n`);
      break;
    }
    if (!current.includes(fault.replace)) {
      die(`cannot restore ${id}: the injected form is not in ${fault.file} (was it changed by hand?)`);
    }

    writeFileSync(path, current.replace(fault.replace, fault.find));
    gitRoot('add', fault.file);
    gitRoot('commit', '-m', fault.restoreCommit);
    process.stdout.write(`${id} restored and committed at ${git('rev-parse', '--short', 'HEAD')}\n`);
    process.stdout.write('now rebuild and redeploy:  ./lab.sh build target-service\n');
    break;
  }

  default:
    process.stderr.write('usage: faults.mjs <list|show|inject|restore|revert> [faultId]\n');
    process.exit(1);
}

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}