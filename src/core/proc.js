'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/** Kill a process and everything it spawned. */
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL'); // children are spawned detached, so -pid is the group
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * GUI apps launched from Finder/Dock inherit a minimal PATH, so `claude`,
 * `codex`, `ollama`... would not be found. Adopt the login shell's PATH and add
 * the usual install locations.
 */
function fixPath() {
  if (isWin) return;
  const home = os.homedir();
  const extra = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
    path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'), path.join(home, '.cargo', 'bin'), path.join(home, '.volta', 'bin'),
  ];
  let shellPath = '';
  try {
    const sh = process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash');
    shellPath = execFileSync(sh, ['-ilc', 'echo -n "__P__$PATH__P__"'], { encoding: 'utf8', timeout: 3500, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('__P__')[1] || '';
  } catch { /* fall back to the static list */ }
  const parts = [...shellPath.split(':'), ...(process.env.PATH || '').split(':'), ...extra].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(':');
}

function which(cmd) {
  try {
    const out = execFileSync(isWin ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Environment for agent child processes. */
function childEnv(extra) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}

/**
 * Resolve how to launch the Codex CLI without going through a .cmd shim
 * (shims need shell quoting, which mangles config overrides on Windows).
 * Returns { command, prefix, env } so callers spawn(command, [...prefix, ...args], { env }).
 */
function resolveCodex(override) {
  if (override) return { command: override, prefix: [] };
  const nodeCmd = (js) => ({
    command: process.execPath,
    prefix: [js],
    // inside Electron, execPath is the Electron binary: make it behave as plain node
    env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : undefined,
  });
  const jsFrom = (dir) => {
    const js = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    return fs.existsSync(js) ? js : null;
  };
  for (const hit of which('codex')) {
    if (/\.(cmd|bat|ps1)$/i.test(hit)) {
      const js = jsFrom(path.dirname(hit));
      if (js) return nodeCmd(js);
    } else if (!isWin || /\.exe$/i.test(hit)) {
      return { command: hit, prefix: [] };
    }
  }
  // dev checkouts have the CLI as a dependency; packaged apps rely on PATH
  const bundled = jsFrom(path.join(__dirname, '..', '..'));
  if (bundled && !bundled.includes('app.asar')) return nodeCmd(bundled);
  return null;
}

function resolveClaude(override) {
  if (override) return { command: override, prefix: [] };
  const hits = which('claude');
  const hit = hits.find((h) => !isWin || /\.exe$/i.test(h)) || hits[0];
  return hit ? { command: hit, prefix: [] } : null;
}

/** Resolve any CLI on PATH (Windows: prefer a real .exe over shims). */
function resolveBin(name, override) {
  if (override) return { command: override, prefix: [] };
  // an explicit path (absolute or relative with a separator) is used as given
  if (/[\\/]/.test(name) && fs.existsSync(name)) return { command: name, prefix: [], shell: isWin && /\.(cmd|bat)$/i.test(name) };
  const hits = which(name);
  const hit = hits.find((h) => !isWin || /\.exe$/i.test(h)) || hits[0];
  if (!hit) return null;
  // npm .cmd shims need a shell on Windows
  return { command: hit, prefix: [], shell: isWin && /\.(cmd|bat)$/i.test(hit) };
}

module.exports = { killTree, which, fixPath, resolveCodex, resolveClaude, resolveBin, childEnv, isWin, isMac };
