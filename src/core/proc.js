'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const isWin = process.platform === 'win32';

/** Kill a process and everything it spawned. */
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function which(cmd) {
  try {
    const out = execFileSync(isWin ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Resolve how to launch the Codex CLI without going through a .cmd shim
 * (shims need shell quoting, which mangles config overrides on Windows).
 * Returns { command, prefix } so callers spawn(command, [...prefix, ...args]).
 */
function resolveCodex(override) {
  if (override) return { command: override, prefix: [] };
  const jsFrom = (dir) => {
    const js = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    return fs.existsSync(js) ? js : null;
  };
  for (const hit of which('codex')) {
    if (/\.(cmd|bat|ps1)$/i.test(hit)) {
      const js = jsFrom(path.dirname(hit));
      if (js) return { command: process.execPath, prefix: [js], asNode: true };
    } else if (!isWin || /\.exe$/i.test(hit)) {
      return { command: hit, prefix: [] };
    }
  }
  const bundled = jsFrom(path.join(__dirname, '..', '..'));
  if (bundled) return { command: process.execPath, prefix: [bundled], asNode: true };
  return null;
}

function resolveClaude(override) {
  if (override) return { command: override, prefix: [] };
  const hit = which('claude').find((h) => !isWin || /\.exe$/i.test(h)) || which('claude')[0];
  return hit ? { command: hit, prefix: [] } : null;
}

/** Child env for Electron-as-node launches and clean nested-CLI behaviour. */
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.CLAUDECODE;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

module.exports = { killTree, which, resolveCodex, resolveClaude, childEnv, isWin };
