'use strict';
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { killTree, childEnv } = require('../proc');

const blankUsage = () => ({ in: 0, out: 0, cached: 0, reasoning: 0, cost: 0 });

/** Normalise any agent's tool call into a small, UI-friendly shape. */
function classifyTool(name, input = {}) {
  const n = String(name || '').toLowerCase();
  const file = input.file_path || input.path || input.notebook_path || null;
  const clip = (s, k = 90) => (s.length > k ? s.slice(0, k - 1) + '…' : s);
  if (['write', 'edit', 'multiedit', 'notebookedit'].includes(n)) {
    // size hint from the tool input, shown while the edit is still in flight
    const count = (s) => (typeof s === 'string' && s ? s.split('\n').length : 0);
    let add = count(input.content) || count(input.new_string);
    let del = count(input.old_string);
    for (const e of input.edits || []) { add += count(e.new_string); del += count(e.old_string); }
    return { kind: 'write', file, summary: file || name, hint: add || del ? { add, del } : null };
  }
  if (n === 'edit' || n === 'apply_patch') return { kind: 'write', file, summary: file || name };
  if (['bash', 'powershell', 'shell', 'command'].includes(n)) {
    const cmd = String(input.command || '').replace(/\s+/g, ' ').trim();
    return { kind: 'shell', file: null, summary: clip(cmd || name) };
  }
  if (n === 'read') return { kind: 'read', file, summary: file || name };
  if (['glob', 'grep', 'ls'].includes(n)) return { kind: 'search', file: null, summary: clip(String(input.pattern || input.query || name)) };
  if (['webfetch', 'websearch'].includes(n)) return { kind: 'web', file: null, summary: clip(String(input.url || input.query || name)) };
  if (['task', 'agent'].includes(n)) return { kind: 'task', file: null, summary: clip(String(input.description || name)) };
  if (n === 'todowrite') return { kind: 'plan', file: null, summary: 'updating plan' };
  return { kind: 'other', file, summary: clip(file || String(name)) };
}

class Agent extends EventEmitter {
  constructor(opts) {
    super();
    this.id = opts.id;
    this.kind = opts.kind;
    this.label = opts.label || opts.id;
    this.model = opts.model || '';
    this.cwd = opts.cwd;
    this.permission = opts.permission || 'workspace';
    this.sessionId = null;
    this.proc = null;
    this.running = false;
    this.turns = 0;
    this.committed = blankUsage();
    this.turnUsage = blankUsage();
    this._final = '';
    this._interrupted = false;
    this._tools = new Map();
  }

  get usage() {
    const c = this.committed;
    const t = this.turnUsage;
    return {
      in: c.in + t.in,
      out: c.out + t.out,
      cached: c.cached + t.cached,
      reasoning: c.reasoning + t.reasoning,
      cost: c.cost + t.cost,
    };
  }

  emitEv(ev) { this.emit('ev', ev); }

  /** Path relative to the workspace, for display. */
  rel(p) {
    if (!p || !path.isAbsolute(p)) return p;
    const r = path.relative(this.cwd, p);
    return r && !r.startsWith('..') ? r.split(path.sep).join('/') : p;
  }
  setFinal(text) { this._final = text || ''; }

  /** Subclasses return { command, args, stdin } for one turn. */
  buildCommand() { throw new Error('not implemented'); }
  /** Subclasses handle one parsed JSON line. */
  handleLine() {}
  /** Subclasses may override to parse non-JSON stdout lines. */
  handleRaw() {}

  async runTurn(prompt) {
    if (this.running) throw new Error(`${this.id} is already running a turn`);
    this.running = true;
    this._interrupted = false;
    this._final = '';
    this._stderr = '';
    this._sawResult = false;
    this._tools.clear();
    this.turnUsage = blankUsage();
    this.turns++;
    this.emitEv({ t: 'turn', phase: 'start', n: this.turns });
    this.emitEv({ t: 'status', state: 'thinking', label: 'Starting…' });

    let spec;
    try {
      spec = this.buildCommand(prompt, this.turns === 1 && !this.sessionId);
    } catch (err) {
      return this._finish({ ok: false, error: err.message });
    }

    return new Promise((resolve) => {
      const child = spawn(spec.command, spec.args, {
        cwd: this.cwd,
        env: childEnv(spec.env),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      this.proc = child;
      let buf = '';
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        this.proc = null;
        resolve(this._finish(r));
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) this._line(line);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { this._stderr = (this._stderr + d).slice(-4000); });
      child.on('error', (err) => done({ ok: false, error: `Could not start ${spec.command}: ${err.message}` }));
      child.on('close', (code) => {
        if (buf.trim()) this._line(buf.trim());
        if (this._interrupted) return done({ ok: false, interrupted: true });
        if (code === 0 || this._sawResult) return done({ ok: !this._failed, error: this._failed });
        const hint = this._stderr.trim().split('\n').slice(-6).join('\n');
        done({ ok: false, error: `${this.label} exited with code ${code}${hint ? `\n${hint}` : ''}` });
      });
      child.stdin.on('error', () => {});
      if (spec.stdin != null) child.stdin.end(spec.stdin);
    });
  }

  _line(line) {
    let obj;
    try { obj = JSON.parse(line); } catch { return this.handleRaw(line); }
    try { this.handleLine(obj); } catch (err) {
      this.emitEv({ t: 'log', level: 'warn', text: `parse error: ${err.message}` });
    }
  }

  _finish({ ok, error, interrupted }) {
    this.running = false;
    this._failed = null;
    // fold the turn's usage into the running total
    const t = this.turnUsage;
    const c = this.committed;
    c.in += t.in; c.out += t.out; c.cached += t.cached; c.reasoning += t.reasoning; c.cost += t.cost;
    this.turnUsage = blankUsage();
    const text = this._final;
    this.emitEv({ t: 'turn', phase: 'end', n: this.turns, ok, interrupted: !!interrupted });
    this.emitEv({ t: 'status', state: 'idle', label: interrupted ? 'Interrupted' : ok ? 'Idle' : 'Error' });
    if (error) this.emitEv({ t: 'error', text: error });
    return { ok, interrupted: !!interrupted, error, text };
  }

  interrupt() {
    if (!this.running) return false;
    this._interrupted = true;
    killTree(this.proc);
    return true;
  }

  // ---- helpers for subclasses -------------------------------------------
  toolStart(id, name, input) {
    const c = classifyTool(name, input);
    c.rel = this.rel(c.file);
    if (c.kind === 'write' || c.kind === 'read') c.summary = c.rel || c.summary;
    this._tools.set(id, { name, ...c });
    this.emitEv({ t: 'tool', phase: 'start', id, name, ...c });
    const verb = { write: 'Editing', shell: 'Running', read: 'Reading', search: 'Searching', web: 'Browsing', task: 'Delegating', plan: 'Planning' }[c.kind] || 'Using';
    this.emitEv({ t: 'status', state: c.kind === 'write' ? 'editing' : 'working', label: `${verb} ${c.summary || name}` });
  }

  toolUpdate(id, input) {
    const prev = this._tools.get(id);
    if (!prev) return;
    const c = classifyTool(prev.name, input);
    c.rel = this.rel(c.file);
    if (c.kind === 'write' || c.kind === 'read') c.summary = c.rel || c.summary;
    Object.assign(prev, c);
    this.emitEv({ t: 'tool', phase: 'update', id, name: prev.name, ...c });
    if (c.kind === 'write' && c.file) {
      const h = c.hint ? ` (${c.hint.add ? `+${c.hint.add}` : ''}${c.hint.del ? ` −${c.hint.del}` : ''})` : '';
      this.emitEv({ t: 'status', state: 'editing', label: `Editing ${c.rel}${h}` });
    }
  }

  toolEnd(id, ok, extra = {}) {
    const prev = this._tools.get(id) || { name: 'tool', kind: 'other', summary: '' };
    this.emitEv({ t: 'tool', phase: 'end', id, ok, ...prev, ...extra });
    this._tools.delete(id);
  }
}

module.exports = { Agent, classifyTool, blankUsage };

