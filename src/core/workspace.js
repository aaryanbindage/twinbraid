'use strict';
const fs = require('node:fs');
const path = require('node:path');

const IGNORE = new Set(['.git', 'node_modules', '.duet', 'dist', 'build', '.next', '.venv', '__pycache__', 'target', '.cache', 'out']);
const MAX_FILE = 512 * 1024;
const MAX_FILES = 4000;

/**
 * Tracks file contents so we can attribute "+N / -M lines" to whichever agent
 * just changed a file, regardless of how it did it (Edit tool, apply_patch,
 * `sed -i` in a shell...). Diffing the filesystem is the one method that works
 * identically for every agent.
 */
class Workspace {
  constructor(cwd) {
    this.cwd = cwd;
    this.files = new Map(); // abs path -> { mtime, size, lines: Map<line,count>|null, n }
    this.truncated = false;
  }

  snapshot() {
    this.files.clear();
    let count = 0;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (count >= MAX_FILES) { this.truncated = true; return; }
        if (e.isDirectory()) {
          if (!IGNORE.has(e.name)) walk(path.join(dir, e.name));
        } else if (e.isFile()) {
          count++;
          this._load(path.join(dir, e.name));
        }
      }
    };
    walk(this.cwd);
    return this.files.size;
  }

  _read(abs) {
    let st;
    try { st = fs.statSync(abs); } catch { return null; }
    if (!st.isFile()) return null;
    const rec = { mtime: st.mtimeMs, size: st.size, lines: null, n: 0 };
    if (st.size <= MAX_FILE) {
      try {
        const buf = fs.readFileSync(abs);
        if (!buf.includes(0)) {
          const lines = buf.toString('utf8').split(/\r?\n/);
          if (lines[lines.length - 1] === '') lines.pop();
          rec.n = lines.length;
          rec.lines = new Map();
          for (const l of lines) rec.lines.set(l, (rec.lines.get(l) || 0) + 1);
        }
      } catch { /* unreadable: treat as binary */ }
    }
    return rec;
  }

  _load(abs) {
    const rec = this._read(abs);
    if (rec) this.files.set(abs, rec);
    return rec;
  }

  _abs(p) {
    return path.isAbsolute(p) ? path.normalize(p) : path.resolve(this.cwd, p);
  }

  /** Line-multiset diff: order-insensitive but exact for add/remove counts. */
  static delta(before, after) {
    if (!after) return { add: before ? before.n : 0, del: before ? before.n : 0 };
    if (!after.lines) return { add: 0, del: 0 };
    if (!before || !before.lines) return { add: after.n, del: 0 };
    let add = 0;
    let del = 0;
    for (const [l, c] of after.lines) add += Math.max(0, c - (before.lines.get(l) || 0));
    for (const [l, c] of before.lines) del += Math.max(0, c - (after.lines.get(l) || 0));
    return { add, del };
  }

  /** Re-check specific paths (file tools) and return per-file deltas. */
  touch(paths) {
    const out = [];
    for (const p of paths) {
      const abs = this._abs(p);
      const before = this.files.get(abs) || null;
      const after = this._read(abs);
      if (before && after && before.mtime === after.mtime && before.size === after.size) continue;
      const d = Workspace.delta(before, after);
      if (after) this.files.set(abs, after); else this.files.delete(abs);
      if (d.add || d.del) out.push({ file: abs, rel: this.rel(abs), ...d, created: !before && !!after });
    }
    return out;
  }

  /** Full mtime sweep (after shell commands, which can change anything). */
  sweep() {
    const seen = new Set();
    const changed = [];
    let count = 0;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (count >= MAX_FILES) return;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (!IGNORE.has(e.name)) walk(abs); continue; }
        if (!e.isFile()) continue;
        count++;
        seen.add(abs);
        const prev = this.files.get(abs);
        let st;
        try { st = fs.statSync(abs); } catch { continue; }
        if (!prev || prev.mtime !== st.mtimeMs || prev.size !== st.size) changed.push(abs);
      }
    };
    walk(this.cwd);
    const out = this.touch(changed);
    for (const abs of [...this.files.keys()]) {
      if (!seen.has(abs) && !fs.existsSync(abs)) {
        out.push(...this.touch([abs]));
      }
    }
    return out;
  }

  rel(abs) {
    const r = path.relative(this.cwd, abs);
    return r && !r.startsWith('..') ? r.split(path.sep).join('/') : abs;
  }
}

module.exports = { Workspace };
