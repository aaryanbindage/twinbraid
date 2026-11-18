'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { killTree, childEnv } = require('../proc');

const SKIP = new Set(['.git', 'node_modules', '.duet', 'dist', 'build', '.next', '.venv', '__pycache__', 'target', 'out']);
const MAX_OUT = 14000;

const clip = (s, n = MAX_OUT) => (s.length > n ? `${s.slice(0, n * 0.6)}\n…[${s.length - n} chars omitted]…\n${s.slice(-n * 0.4)}` : s);

/** Tool names match Claude Code's so the UI classifies them identically. */
const DEFINITIONS = [
  { name: 'Read', description: 'Read a text file. Returns numbered lines.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'integer', description: '1-based first line' }, limit: { type: 'integer', description: 'max lines (default 400)' } }, required: ['file_path'] } },
  { name: 'Write', description: 'Create or overwrite a file with the given full content.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
  { name: 'Edit', description: 'Replace old_string with new_string in a file. old_string must match exactly once unless replace_all is true.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['file_path', 'old_string', 'new_string'] } },
  { name: 'LS', description: 'List a directory.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'Glob', description: 'Find files by glob pattern such as src/**/*.js.', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Grep', description: 'Search file contents with a regular expression.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Bash', description: 'Run a shell command in the workspace and return its output (stdout+stderr). Use for tests, builds, git.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_s: { type: 'integer' } }, required: ['command'] } },
];

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

class Toolbox {
  constructor({ cwd, permission = 'workspace' }) {
    this.cwd = cwd;
    this.permission = permission;
    this.proc = null;
  }

  definitions() {
    const writes = this.permission !== 'careful';
    return DEFINITIONS
      .filter((d) => writes || !['Write', 'Edit', 'Bash'].includes(d.name))
      .map((d) => ({ type: 'function', function: d }));
  }

  abort() { killTree(this.proc); }

  _resolve(p, write) {
    const abs = path.isAbsolute(p || '.') ? path.normalize(p) : path.resolve(this.cwd, p || '.');
    if (this.permission !== 'full') {
      const rel = path.relative(this.cwd, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`${write ? 'writing' : 'reading'} outside the workspace is not allowed (${p})`);
      }
    }
    return abs;
  }

  *_walk(dir, depth = 0) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name) && depth < 12) yield* this._walk(abs, depth + 1); } else if (e.isFile()) yield abs;
    }
  }

  async run(name, args) {
    if (this.permission === 'careful' && ['Write', 'Edit', 'Bash'].includes(name)) {
      return { ok: false, output: `${name} is disabled in read-only mode.` };
    }
    try {
      switch (name) {
        case 'Read': return this._read(args);
        case 'Write': return this._write(args);
        case 'Edit': return this._edit(args);
        case 'LS': return this._ls(args);
        case 'Glob': return this._glob(args);
        case 'Grep': return this._grep(args);
        case 'Bash': return await this._bash(args);
        default: return { ok: false, output: `Unknown tool "${name}". Available: ${DEFINITIONS.map((d) => d.name).join(', ')}` };
      }
    } catch (err) {
      return { ok: false, output: `Error: ${err.message}` };
    }
  }

  _read({ file_path: p, offset = 1, limit = 400 }) {
    const abs = this._resolve(p);
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    const start = Math.max(1, offset);
    const slice = lines.slice(start - 1, start - 1 + limit);
    const body = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
    const more = start - 1 + limit < lines.length ? `\n…(${lines.length - (start - 1 + limit)} more lines; use offset)` : '';
    return { ok: true, output: clip(body + more) };
  }

  _write({ file_path: p, content }) {
    if (typeof content !== 'string') throw new Error('content must be a string');
    const abs = this._resolve(p, true);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return { ok: true, output: `Wrote ${content.split('\n').length} lines to ${p}` };
  }

  _edit({ file_path: p, old_string: a, new_string: b, replace_all: all }) {
    const abs = this._resolve(p, true);
    const text = fs.readFileSync(abs, 'utf8');
    if (!a) throw new Error('old_string is empty');
    const count = text.split(a).length - 1;
    if (count === 0) throw new Error('old_string not found. Re-read the file and copy the text exactly.');
    if (count > 1 && !all) throw new Error(`old_string matches ${count} times. Add more context or set replace_all.`);
    fs.writeFileSync(abs, all ? text.split(a).join(b) : text.replace(a, () => b));
    return { ok: true, output: `Edited ${p} (${all ? count : 1} replacement${count > 1 && all ? 's' : ''})` };
  }

  _ls({ path: p }) {
    const abs = this._resolve(p || '.');
    const out = fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => !SKIP.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return { ok: true, output: out.join('\n') || '(empty)' };
  }

  _glob({ pattern }) {
    const re = globToRegex(pattern.replace(/^\.\//, ''));
    const hits = [];
    for (const abs of this._walk(this.cwd)) {
      const rel = path.relative(this.cwd, abs).split(path.sep).join('/');
      if (re.test(rel)) hits.push(rel);
      if (hits.length >= 200) break;
    }
    return { ok: true, output: hits.join('\n') || 'no matches' };
  }

  _grep({ pattern, path: p }) {
    let re;
    try { re = new RegExp(pattern); } catch (err) { throw new Error(`bad regex: ${err.message}`); }
    const root = this._resolve(p || '.');
    const files = fs.statSync(root).isFile() ? [root] : this._walk(root);
    const out = [];
    for (const abs of files) {
      let text;
      try {
        if (fs.statSync(abs).size > 512 * 1024) continue;
        text = fs.readFileSync(abs, 'utf8');
      } catch { continue; }
      if (text.includes('\0')) continue;
      const rel = path.relative(this.cwd, abs).split(path.sep).join('/');
      text.split(/\r?\n/).forEach((l, i) => { if (out.length < 100 && re.test(l)) out.push(`${rel}:${i + 1}: ${l.slice(0, 200)}`); });
      if (out.length >= 100) break;
    }
    return { ok: true, output: out.join('\n') || 'no matches' };
  }

  _bash({ command, timeout_s: t }) {
    return new Promise((resolve) => {
      const timeout = Math.min(Math.max(Number(t) || 120, 1), 600) * 1000;
      const child = spawn(command, {
        cwd: this.cwd, shell: true, env: childEnv(), windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.proc = child;
      let out = '';
      const add = (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      const timer = setTimeout(() => { killTree(child); out += `\n[timed out after ${timeout / 1000}s]`; }, timeout);
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: `Error: ${e.message}` }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        this.proc = null;
        resolve({ ok: code === 0, output: clip(`${out.trim() || '(no output)'}\n[exit ${code}]`) });
      });
    });
  }
}

module.exports = { Toolbox, DEFINITIONS, globToRegex };
