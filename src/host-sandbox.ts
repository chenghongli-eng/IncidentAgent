/**
 * Opt-in filesystem sandbox for host-mode workspaces.
 *
 * Host mode runs the agent runner as a plain child process of the Miniclaw
 * server. It inherits the server's uid, so it can read every file the
 * server's user can read — that is the documented product behaviour (host
 * mode is an admin-only privilege), but it also means a host-mode workspace
 * can read credentials, answer keys and deployment ledgers that happen to
 * live next to the workspace.
 *
 * This module adds a **bubblewrap** sandbox that a workspace can opt into
 * through `container_config.hostSandbox`. Without that field the spawn path
 * is unchanged.
 *
 * Posture: allowlist. Only the paths the runner genuinely needs are bound
 * into the sandbox; everything else on the host is invisible. The home
 * directory is replaced by an empty tmpfs unless the workspace explicitly
 * binds the parts of it the runtime needs.
 *
 * Two deliberate non-goals:
 *   - The sandbox is a **filesystem** boundary. It does not restrict the
 *     network: the runner still needs to reach Prometheus, the target
 *     service and the model endpoint.
 *   - It does not restrict the process table. `/proc` stays visible because
 *     the read-only observation channels derive the target's process anchor
 *     from `lsof`; a PID namespace would make that channel lie.
 */
import fs from 'fs';
import path from 'path';

export interface HostSandboxConfig {
  provider: 'bwrap';
  /** Extra host paths bound read-write into the sandbox. */
  writablePaths?: string[];
  /** Extra host paths bound read-only into the sandbox. */
  readablePaths?: string[];
  /**
   * Replace the home directory with an empty tmpfs. Default true: the home
   * directory is where credentials and answer keys tend to live.
   */
  isolateHome?: boolean;
  /**
   * Pass the parent environment through. Default true. When false only the
   * product-owned variables (provider credentials, workspace paths) and a
   * small system allowlist survive.
   */
  inheritEnv?: boolean;
  /** Unshare the PID namespace. Default false — see module header. */
  unsharePid?: boolean;
  /**
   * Environment overrides applied inside the sandbox. Typical use: putting a
   * capability shim directory at the front of PATH.
   */
  env?: Record<string, string>;
}

export interface HostSandboxPlanInput {
  config?: HostSandboxConfig;
  /** Workspace directory (cwd). Read-write. */
  workspaceDir: string;
  /** Session directory (CLAUDE_CONFIG_DIR). Read-write. */
  sessionsDir: string;
  /** IPC directory. Read-write. */
  ipcDir: string;
  /** agent-runner root (dist, node_modules, prompts). Read-only. */
  agentRunnerRoot: string;
  /** Node binary used to launch the runner. Its directory is bound read-only. */
  nodeBinary: string;
  /** Command to run inside the sandbox. */
  command: string;
  /** Arguments for that command. */
  commandArgs: string[];
  /** Environment the runner would have received without a sandbox. */
  env: Record<string, string>;
  /** Working directory inside the sandbox. */
  cwd: string;
  /** Product-owned read-only paths (skills, plugins, runtime snapshots). */
  readablePaths?: string[];
  /** Product-owned read-write paths. */
  writablePaths?: string[];
}

export interface HostSandboxPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** System roots every runner needs: binaries, shared libraries, configuration. */
const SYSTEM_READ_ROOTS = ['/usr', '/etc', '/opt'];
/** `/bin`, `/lib`, ... are symlinks into `/usr` on modern distributions. */
const SYSTEM_SYMLINKS: Record<string, string> = {
  '/bin': 'usr/bin',
  '/sbin': 'usr/sbin',
  '/lib': 'usr/lib',
  '/lib64': 'usr/lib64',
};
const SANDBOX_HOME = '/tmp/miniclaw-sandbox-home';
const SANDBOX_HOME_ENV = 'MINICLAW_SANDBOX_HOME';

const ENV_ALLOW_EXACT = new Set([
  'PATH',
  'HOME',
  'TZ',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'TMPDIR',
  'NODE_OPTIONS',
  'NO_PROXY',
  'no_proxy',
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
]);
const ENV_ALLOW_PREFIXES = ['ANTHROPIC_', 'MINICLAW_', 'CLAUDE_', 'PI_'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePathList(
  raw: unknown,
  field: string,
): { paths?: string[]; error?: string } {
  if (raw === undefined) return {};
  if (!Array.isArray(raw)) {
    return { error: `hostSandbox.${field} must be an array of absolute paths` };
  }
  const paths: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'string' || !entry.trim()) {
      return {
        error: `hostSandbox.${field}[${index}] must be a non-empty string`,
      };
    }
    const trimmed = entry.trim();
    if (!path.isAbsolute(trimmed)) {
      return {
        error: `hostSandbox.${field}[${index}] must be an absolute path`,
      };
    }
    if (trimmed.includes('..')) {
      return {
        error: `hostSandbox.${field}[${index}] must not contain ".."`,
      };
    }
    paths.push(trimmed);
  }
  return { paths };
}

/**
 * Validate the `hostSandbox` block of a workspace's container_config.
 *
 * Invalid configuration is rejected rather than repaired: a sandbox that
 * silently drops a path is a sandbox that silently does not protect.
 */
export function parseHostSandboxConfig(raw: unknown): {
  config?: HostSandboxConfig;
  error?: string;
} {
  if (!isRecord(raw)) return { error: 'hostSandbox must be an object' };
  if (raw.provider !== 'bwrap') {
    return { error: 'hostSandbox.provider must be "bwrap"' };
  }

  const writable = parsePathList(raw.writablePaths, 'writablePaths');
  if (writable.error) return { error: writable.error };
  const readable = parsePathList(raw.readablePaths, 'readablePaths');
  if (readable.error) return { error: readable.error };

  for (const [key, value] of [
    ['isolateHome', raw.isolateHome],
    ['inheritEnv', raw.inheritEnv],
    ['unsharePid', raw.unsharePid],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      return { error: `hostSandbox.${key} must be a boolean` };
    }
  }

  let env: Record<string, string> | undefined;
  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) {
      return { error: 'hostSandbox.env must be an object' };
    }
    env = {};
    for (const [key, value] of Object.entries(raw.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return {
          error: `hostSandbox.env has an invalid variable name: ${key}`,
        };
      }
      if (typeof value !== 'string') {
        return { error: `hostSandbox.env.${key} must be a string` };
      }
      env[key] = value;
    }
  }

  const unknown = Object.keys(raw).filter(
    (key) =>
      ![
        'provider',
        'writablePaths',
        'readablePaths',
        'isolateHome',
        'inheritEnv',
        'unsharePid',
        'env',
      ].includes(key),
  );
  if (unknown.length > 0) {
    return {
      error: `hostSandbox contains unknown fields: ${unknown.join(', ')}`,
    };
  }

  return {
    config: {
      provider: 'bwrap',
      ...(writable.paths !== undefined
        ? { writablePaths: writable.paths }
        : {}),
      ...(readable.paths !== undefined
        ? { readablePaths: readable.paths }
        : {}),
      ...(raw.isolateHome !== undefined
        ? { isolateHome: raw.isolateHome as boolean }
        : {}),
      ...(raw.inheritEnv !== undefined
        ? { inheritEnv: raw.inheritEnv as boolean }
        : {}),
      ...(raw.unsharePid !== undefined
        ? { unsharePid: raw.unsharePid as boolean }
        : {}),
      ...(env !== undefined ? { env } : {}),
    },
  };
}

function exists(target: string): boolean {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a path for binding. Symlinks are resolved so the bind lands on the
 * real directory: bwrap refuses to mount onto a path whose target is not a
 * directory, and a symlinked workspace would otherwise be invisible.
 */
function realOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function buildSandboxEnv(
  input: HostSandboxPlanInput,
  home: string,
): Record<string, string> {
  const base: Record<string, string> = {};
  if (input.config?.inheritEnv !== false) {
    Object.assign(base, input.env);
  } else {
    for (const [key, value] of Object.entries(input.env)) {
      if (
        ENV_ALLOW_EXACT.has(key) ||
        ENV_ALLOW_PREFIXES.some((prefix) => key.startsWith(prefix))
      ) {
        base[key] = value;
      }
    }
  }
  base['HOME'] = home;
  base[SANDBOX_HOME_ENV] = '1';
  return base;
}

/**
 * Build the bubblewrap invocation for a host-mode run.
 *
 * Returns null when no sandbox is configured — the caller then spawns the
 * runner exactly as it did before.
 */
export function buildHostSandboxPlan(
  input: HostSandboxPlanInput,
): HostSandboxPlan | null {
  const config = input.config;
  if (!config || config.provider !== 'bwrap') return null;

  const isolateHome = config.isolateHome !== false;
  const home = isolateHome ? SANDBOX_HOME : (input.env['HOME'] ?? SANDBOX_HOME);

  const args: string[] = ['--unshare-user'];

  // System roots.
  for (const root of SYSTEM_READ_ROOTS) {
    if (exists(root)) args.push('--ro-bind', root, root);
  }
  for (const [link, target] of Object.entries(SYSTEM_SYMLINKS)) {
    args.push('--symlink', target, link);
  }

  // Kernel filesystems.
  args.push('--proc', '/proc', '--dev', '/dev');
  args.push('--tmpfs', '/tmp');
  if (isolateHome) {
    args.push('--dir', home);
  }

  // Product-owned paths.
  //
  // Each path is bound **at the path the runner actually uses** — a bind at a
  // different spelling would leave the runner looking at a missing directory.
  // When the path contains a symlink component, the resolved target is bound
  // as well so that code resolving the path itself keeps working.
  const readOnlyPaths = new Set<string>();
  const readWritePaths = new Set<string>();

  const addPath = (target: string, mode: 'ro' | 'rw'): void => {
    if (!target || target === '/') return;
    // A path that does not exist has nothing to protect. Binding it would
    // make bubblewrap refuse to start at all.
    if (!exists(target)) return;
    const resolved = realOrSelf(target);
    const wanted = mode === 'rw' ? readWritePaths : readOnlyPaths;
    const other = mode === 'rw' ? readOnlyPaths : readWritePaths;
    for (const candidate of new Set([target, resolved])) {
      if (!candidate || candidate === '/') continue;
      if (wanted.has(candidate)) continue;
      if (other.has(candidate)) {
        // A path bound both ways: the writable binding wins.
        other.delete(candidate);
        wanted.add(candidate);
        continue;
      }
      wanted.add(candidate);
    }
  };
  const addReadOnly = (target: string): void => addPath(target, 'ro');
  const addReadWrite = (target: string): void => addPath(target, 'rw');

  addReadWrite(input.workspaceDir);
  addReadWrite(input.sessionsDir);
  addReadWrite(input.ipcDir);
  addReadOnly(input.agentRunnerRoot);
  addReadOnly(path.dirname(input.nodeBinary));
  for (const target of input.readablePaths ?? []) addReadOnly(target);
  for (const target of input.writablePaths ?? []) addReadWrite(target);
  for (const target of config.readablePaths ?? []) addReadOnly(target);
  for (const target of config.writablePaths ?? []) addReadWrite(target);

  for (const target of [...readOnlyPaths].sort()) {
    args.push('--ro-bind', target, target);
  }
  for (const target of [...readWritePaths].sort()) {
    args.push('--bind', target, target);
  }

  // Home: isolated (empty tmpfs) or the real one, read-only. When the home is
  // isolated the workspace may still bind the parts of it the runtime needs
  // through `readablePaths`.
  if (!isolateHome) {
    const realHome = realOrSelf(home);
    if (exists(realHome)) {
      args.push('--ro-bind', realHome, realHome);
    }
  }

  args.push('--chdir', input.cwd);
  args.push('--unshare-uts');
  args.push('--unshare-ipc');
  if (config.unsharePid === true) args.push('--unshare-pid');
  // The runner is a child of the Miniclaw server: if the server dies, the
  // sandbox must not outlive it holding the workspace.
  args.push('--die-with-parent');
  args.push('--setenv', 'HOME', home);
  args.push('--setenv', SANDBOX_HOME_ENV, '1');
  const sandboxEnv = buildSandboxEnv(input, home);
  for (const [key, value] of Object.entries(config.env ?? {})) {
    sandboxEnv[key] = value;
    args.push('--setenv', key, value);
  }
  args.push('--');
  args.push(input.command, ...input.commandArgs);

  return {
    command: 'bwrap',
    args,
    env: sandboxEnv,
  };
}

/** True when the process looks like it is already running under a sandbox. */
export function isInsideHostSandbox(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[SANDBOX_HOME_ENV] === '1';
}

/**
 * Collect the absolute targets of symlinks inside a directory tree.
 *
 * The session directory contains symlinks that point into the user's home
 * (`.claude.json`, `plugins/`). Inside the sandbox those targets would dangle
 * and the runtime would either fail to start or silently lose a capability.
 * Binding the targets read-only keeps the runtime intact without opening the
 * whole home directory.
 */
export function collectExternalSymlinkTargets(
  root: string,
  maxDepth = 2,
): string[] {
  const targets = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const resolved = fs.realpathSync(full);
          if (path.isAbsolute(resolved) && !resolved.startsWith(`${root}/`)) {
            targets.add(resolved);
          }
        } catch {
          // Dangling symlink: nothing to bind.
        }
        continue;
      }
      if (entry.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return [...targets];
}
