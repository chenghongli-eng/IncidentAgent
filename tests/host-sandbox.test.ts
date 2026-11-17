import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildHostSandboxPlan,
  collectExternalSymlinkTargets,
  isInsideHostSandbox,
  parseHostSandboxConfig,
} from '../src/host-sandbox.js';
import { parseContainerConfig } from '../src/mount-security.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-host-sandbox-'));

function bwrapAvailable(): boolean {
  try {
    execFileSync('bwrap', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('parseHostSandboxConfig', () => {
  it('accepts a minimal block', () => {
    const parsed = parseHostSandboxConfig({ provider: 'bwrap' });
    expect(parsed.error).toBeUndefined();
    expect(parsed.config?.provider).toBe('bwrap');
  });

  it('rejects an unknown provider', () => {
    expect(parseHostSandboxConfig({ provider: 'docker' }).error).toContain(
      'provider',
    );
  });

  it('rejects unknown fields instead of ignoring them', () => {
    const parsed = parseHostSandboxConfig({ provider: 'bwrap', nope: 1 });
    expect(parsed.error).toContain('unknown fields');
  });

  it('rejects relative paths', () => {
    const parsed = parseHostSandboxConfig({
      provider: 'bwrap',
      readablePaths: ['relative/path'],
    });
    expect(parsed.error).toContain('absolute path');
  });

  it('rejects traversal in paths', () => {
    const parsed = parseHostSandboxConfig({
      provider: 'bwrap',
      writablePaths: ['/tmp/../etc'],
    });
    expect(parsed.error).toContain('..');
  });

  it('rejects non-boolean flags', () => {
    expect(
      parseHostSandboxConfig({ provider: 'bwrap', isolateHome: 'yes' }).error,
    ).toContain('isolateHome');
  });

  it('rejects invalid env variable names', () => {
    expect(
      parseHostSandboxConfig({
        provider: 'bwrap',
        env: { 'BAD NAME': 'x' },
      }).error,
    ).toContain('invalid variable name');
  });

  it('keeps env overrides', () => {
    const parsed = parseHostSandboxConfig({
      provider: 'bwrap',
      env: { PATH: '/opt/bin:/usr/bin' },
    });
    expect(parsed.config?.env).toEqual({ PATH: '/opt/bin:/usr/bin' });
  });
});

describe('parseContainerConfig', () => {
  it('round-trips a host sandbox block', () => {
    const parsed = parseContainerConfig({
      version: 1,
      hostSandbox: { provider: 'bwrap', readablePaths: ['/opt/thing'] },
    });
    expect(parsed.error).toBeUndefined();
    expect(parsed.config?.hostSandbox?.readablePaths).toEqual(['/opt/thing']);
  });

  it('fails closed on an invalid host sandbox block', () => {
    const parsed = parseContainerConfig({
      version: 1,
      hostSandbox: { provider: 'nope' },
    });
    expect(parsed.error).toBeDefined();
    expect(parsed.config).toBeUndefined();
  });
});

describe('buildHostSandboxPlan', () => {
  const workspace = path.join(TMP, 'workspace');
  const sessions = path.join(TMP, 'sessions');
  const ipc = path.join(TMP, 'ipc');
  const runner = path.join(TMP, 'runner');

  beforeAll(() => {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(ipc, { recursive: true });
    fs.mkdirSync(runner, { recursive: true });
  });

  const baseInput = () => ({
    config: { provider: 'bwrap' as const },
    workspaceDir: workspace,
    sessionsDir: sessions,
    ipcDir: ipc,
    agentRunnerRoot: runner,
    nodeBinary: process.execPath,
    command: process.execPath,
    commandArgs: ['-e', 'process.exit(0)'],
    env: { PATH: '/usr/bin', HOME: '/home/tester' },
    cwd: workspace,
  });

  it('returns null when no sandbox is configured', () => {
    expect(
      buildHostSandboxPlan({ ...baseInput(), config: undefined }),
    ).toBeNull();
  });

  it('binds the workspace, the session directory and the IPC directory writable', () => {
    const plan = buildHostSandboxPlan(baseInput());
    expect(plan).not.toBeNull();
    const args = plan!.args.join(' ');
    expect(args).toContain(`--bind ${workspace} ${workspace}`);
    expect(args).toContain(`--bind ${sessions} ${sessions}`);
    expect(args).toContain(`--bind ${ipc} ${ipc}`);
  });

  it('binds the agent-runner root read-only', () => {
    const plan = buildHostSandboxPlan(baseInput());
    expect(plan!.args.join(' ')).toContain(`--ro-bind ${runner} ${runner}`);
  });

  it('replaces the home directory with an empty directory', () => {
    const plan = buildHostSandboxPlan(baseInput());
    expect(plan!.env['HOME']).not.toBe('/home/tester');
    expect(plan!.args.join(' ')).toContain('--dir /tmp/miniclaw-sandbox-home');
  });

  it('keeps the real home when isolation is turned off', () => {
    const plan = buildHostSandboxPlan({
      ...baseInput(),
      config: { provider: 'bwrap', isolateHome: false },
    });
    expect(plan!.env['HOME']).toBe('/home/tester');
  });

  it('applies env overrides to the child environment', () => {
    const plan = buildHostSandboxPlan({
      ...baseInput(),
      config: {
        provider: 'bwrap',
        env: { PATH: '/opt/shim:/usr/bin' },
      },
    });
    expect(plan!.env['PATH']).toBe('/opt/shim:/usr/bin');
    expect(plan!.args.join(' ')).toContain('--setenv PATH /opt/shim:/usr/bin');
  });

  it('skips paths that do not exist', () => {
    const plan = buildHostSandboxPlan({
      ...baseInput(),
      readablePaths: [path.join(TMP, 'not-there')],
    });
    expect(plan!.args.join(' ')).not.toContain('not-there');
  });

  it('marks the sandbox in the environment', () => {
    const plan = buildHostSandboxPlan(baseInput());
    expect(isInsideHostSandbox(plan!.env)).toBe(true);
    expect(isInsideHostSandbox({})).toBe(false);
  });
});

describe('collectExternalSymlinkTargets', () => {
  it('finds symlink targets outside the tree', () => {
    const root = path.join(TMP, 'links');
    const outside = path.join(TMP, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'link'));
    fs.symlinkSync(path.join(root, 'inner'), path.join(root, 'inner-link'));
    const targets = collectExternalSymlinkTargets(root);
    expect(targets).toContain(fs.realpathSync(outside));
    expect(targets.some((t) => t.endsWith('/inner'))).toBe(false);
  });
});

describe.runIf(bwrapAvailable())('bubblewrap integration', () => {
  const secret = path.join(TMP, 'secret.txt');
  const visible = path.join(TMP, 'visible.txt');
  const workspace = path.join(TMP, 'ws');

  beforeAll(() => {
    fs.writeFileSync(secret, 'the answer is 42');
    fs.writeFileSync(visible, 'hello');
    fs.mkdirSync(workspace, { recursive: true });
  });

  it('hides paths that are not bound and shows the ones that are', () => {
    const probe = `
      const fs = require('fs');
      const out = {
        secret: fs.existsSync(${JSON.stringify(secret)}),
        visible: fs.existsSync(${JSON.stringify(visible)}),
        home: process.env.HOME,
      };
      process.stdout.write(JSON.stringify(out));
    `;
    const plan = buildHostSandboxPlan({
      config: { provider: 'bwrap' },
      workspaceDir: workspace,
      sessionsDir: workspace,
      ipcDir: workspace,
      agentRunnerRoot: path.join(TMP, 'runner'),
      nodeBinary: process.execPath,
      command: process.execPath,
      commandArgs: ['-e', probe],
      env: { PATH: process.env.PATH ?? '', HOME: os.homedir() },
      cwd: workspace,
      readablePaths: [visible],
    });
    const stdout = execFileSync(plan!.command, plan!.args, {
      encoding: 'utf8',
      env: plan!.env,
    });
    const result = JSON.parse(stdout);
    expect(result.secret).toBe(false);
    expect(result.visible).toBe(true);
    expect(result.home).not.toBe(os.homedir());
  });
});
