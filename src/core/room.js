'use strict';
const { EventEmitter } = require('node:events');
const { parseTurnEnd, formatInbox } = require('./protocol');
const { Workspace } = require('./workspace');

const CLAIM_TTL_MS = 10 * 60 * 1000;
const MAX_FORWARD = 6000;
const HISTORY_CAP = 60000;

/**
 * A Room runs two (or more) agents in one workspace. It owns their inboxes,
 * routes the final message of each turn to the peer, lets the human interrupt
 * or broadcast, and keeps live stats. Agents never talk to each other directly.
 */
class Room extends EventEmitter {
  constructor({ cwd, agents, maxExchanges = 14 }) {
    super();
    this.cwd = cwd;
    this.maxExchanges = maxExchanges;
    this.ws = new Workspace(cwd);
    this.seq = 0;
    this.history = [];
    this.exchanges = 0;
    this.claims = new Map();
    this.started = false;
    this.startedAt = 0;
    this.stopped = false;
    this.lastIdle = null;
    this.slots = new Map();
    this._statsTimer = null;

    for (const agent of agents) {
      const slot = {
        agent,
        inbox: [],
        notes: [],
        held: false,
        done: false,
        asking: false,
        wasInterrupted: false,
        state: 'idle',
        label: 'Idle',
        add: 0,
        del: 0,
        files: new Set(),
        tools: 0,
        activeMs: 0,
        turnStart: 0,
        thinkingTokens: 0,
      };
      this.slots.set(agent.id, slot);
      agent.on('ev', (ev) => this._onAgentEvent(slot, ev));
    }
  }

  get ids() { return [...this.slots.keys()]; }
  peerOf(id) { return this.ids.find((x) => x !== id); }

  _emit(ev) {
    const full = { seq: ++this.seq, ts: Date.now(), ...ev };
    this.history.push(full);
    if (this.history.length > HISTORY_CAP) this.history.splice(0, HISTORY_CAP / 10);
    this.emit('event', full);
    return full;
  }

  chat(from, to, text, extra = {}) {
    return this._emit({ t: 'chat', id: `m${this.seq + 1}`, from, to, text, ...extra });
  }

  // ---- lifecycle ----------------------------------------------------------
  start(task) {
    if (this.started) throw new Error('Room already started');
    this.started = true;
    this.startedAt = Date.now();
    const n = this.ws.snapshot();
    this._emit({
      t: 'session',
      cwd: this.cwd,
      task,
      agents: this.ids.map((id) => {
        const a = this.slots.get(id).agent;
        return { id, kind: a.kind, label: a.label, model: a.model, permission: a.permission, color: a.color };
      }),
      files: n,
    });
    this.chat('user', 'both', task, { kind: 'task' });
    for (const slot of this.slots.values()) slot.inbox.push({ from: 'user', text: task });
    this._emitRoom('running');
    this._pump();
  }

  /** Emit a room state change; returns false when nothing changed. */
  _emitRoom(state, reason) {
    const key = `${state}:${reason || ''}`;
    if (key === this.lastIdle) return false;
    this.lastIdle = key;
    this._emit({ t: 'room', state, reason });
    return true;
  }

  // ---- human controls -----------------------------------------------------
  /** Message one agent or both. `interrupt` cuts in immediately. */
  send({ to = 'both', text, interrupt = false }) {
    text = (text || '').trim();
    if (!text) return;
    const targets = to === 'both' ? this.ids : [to].filter((id) => this.slots.has(id));
    if (!targets.length) return;
    this.stopped = false;
    this.exchanges = 0;
    this.chat('user', to, text, { kind: 'user', interrupt });
    for (const id of targets) {
      const slot = this.slots.get(id);
      slot.inbox.push({ from: 'user', text });
      slot.held = false;
      slot.done = false;
      slot.asking = false;
      if (interrupt && slot.agent.running) {
        slot.wasInterrupted = true;
        slot.agent.interrupt();
      }
      this._emitInbox(slot);
    }
    this._emitRoom('running');
    this._pump();
  }

  /** Stop one agent's current turn and hold it until the human says otherwise. */
  interrupt(id) {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.held = true;
    slot.wasInterrupted = true;
    this.chat('system', id, `${slot.agent.label} interrupted by you and held.`, { kind: 'interrupt' });
    if (slot.agent.running) slot.agent.interrupt();
    this._setSlotState(slot, 'held', 'Held');
    this._emitInbox(slot);
    this._checkIdle();
  }

  resume(id) {
    const slot = this.slots.get(id);
    if (!slot || !slot.held) return;
    slot.held = false;
    if (!slot.inbox.length) {
      slot.inbox.push({ from: 'system', text: 'The supervisor resumed you. Continue, but re-read any files your peer may have changed meanwhile.' });
    }
    this.chat('system', id, `${slot.agent.label} resumed.`, { kind: 'interrupt' });
    this._emitRoom('running');
    this._pump();
  }

  stopAll() {
    this.stopped = true;
    for (const id of this.ids) {
      const slot = this.slots.get(id);
      slot.held = true;
      slot.wasInterrupted = slot.wasInterrupted || slot.agent.running;
      if (slot.agent.running) slot.agent.interrupt();
      this._setSlotState(slot, 'held', 'Held');
    }
    this.chat('system', 'both', 'Everything stopped. Send a message or resume an agent to continue.', { kind: 'interrupt' });
    this._checkIdle();
  }

  // ---- scheduling ---------------------------------------------------------
  _pump() {
    if (this.stopped) return;
    for (const slot of this.slots.values()) {
      if (slot.agent.running || slot.held || !slot.inbox.length) continue;
      const onlyAgents = slot.inbox.every((m) => m.from !== 'user' && m.from !== 'system');
      if (onlyAgents && this.exchanges >= this.maxExchanges) continue;
      this._startTurn(slot);
    }
    this._checkIdle();
  }

  async _startTurn(slot) {
    const msgs = slot.inbox.splice(0);
    const pre = [];
    if (slot.wasInterrupted) {
      pre.push({ from: 'system', text: 'Your previous turn was interrupted by the supervisor before you finished. Files may be half-edited; re-check them.' });
      slot.wasInterrupted = false;
    }
    for (const n of slot.notes.splice(0)) pre.push({ from: 'system', text: n });
    const prompt = formatInbox([...pre, ...msgs]);
    slot.done = false;
    slot.asking = false;
    slot.turnStart = Date.now();
    this._emitInbox(slot);
    this._emitRoom('running');

    // agents that emit no tool events (plain-text CLIs) are watched via the filesystem instead
    // (only while the peer is idle: otherwise the peer's edits would be credited to this agent)
    const peerBusy = () => [...this.slots.values()].some((s) => s !== slot && s.agent.running);
    const poll = slot.agent.noToolEvents ? setInterval(() => { if (!peerBusy()) this._record(slot, this._safeSweep()); }, 2000) : null;
    let result;
    try {
      result = await slot.agent.runTurn(prompt);
    } catch (err) {
      result = { ok: false, error: err.message, text: '' };
    }
    if (poll) { clearInterval(poll); this._record(slot, this._safeSweep()); }
    slot.activeMs += Date.now() - slot.turnStart;
    slot.turnStart = 0;
    this._afterTurn(slot, result);
  }

  _afterTurn(slot, result) {
    const me = slot.agent;
    const peer = this.peerOf(me.id);
    this._pushStats(true);

    if (result.interrupted) {
      this._setSlotState(slot, slot.held ? 'held' : 'idle', slot.held ? 'Held' : 'Interrupted');
      this._pump();
      return;
    }
    if (!result.ok) {
      this._setSlotState(slot, 'error', 'Error');
      this.chat('system', me.id, `${me.label} failed: ${result.error || 'unknown error'}`, { kind: 'error' });
      this._pump();
      return;
    }

    const r = parseTurnEnd(result.text);
    this._setSlotState(slot, 'idle', 'Idle');
    if (r.ask) {
      slot.asking = true;
      this.chat(me.id, 'user', r.body || '(needs your input)', { kind: 'ask' });
      this._emit({ t: 'attention', agent: me.id, text: r.body });
    } else if (r.done && !me.noToolEvents && slot.tools === 0 && (slot.rubberStamps || 0) < 2) {
      // agreeing to "done" without reading or running anything is a rubber stamp (weak local models do this)
      slot.rubberStamps = (slot.rubberStamps || 0) + 1;
      this.chat('system', me.id, `${me.label} said it was done without reading or running anything. Asked it to check the files and run the tests first.`, { kind: 'system' });
      slot.inbox.push({ from: 'system', text: 'You said the task is done, but you have not read a file or run a command this session. Check what is actually on disk (list and read the files), run the tests, do any part of the work that is yours and still missing, then report what you verified.' });
      this._emitInbox(slot);
    } else if (r.done) {
      slot.done = true;
      this.chat(me.id, peer, r.body || 'Done.', { kind: 'done' });
      const peerSlot = this.slots.get(peer);
      if (!peerSlot.done) {
        peerSlot.inbox.push({ from: me.id, text: clip(`${r.body}\n(${me.label} marked the task done. Reply [[done]] if you agree, otherwise say what is missing.)`) });
        this.exchanges++;
        this._emitInbox(peerSlot);
      }
    } else if (r.silent) {
      if (r.body) this.chat(me.id, null, r.body, { kind: 'note' });
    } else {
      this.chat(me.id, peer, r.body, { kind: 'agent' });
      const peerSlot = this.slots.get(peer);
      peerSlot.inbox.push({ from: me.id, text: clip(r.body) });
      this.exchanges++;
      this._emitInbox(peerSlot);
    }
    this._pump();
  }

  _checkIdle() {
    const slots = [...this.slots.values()];
    if (slots.some((s) => s.agent.running)) return;
    const ready = slots.some((s) => !s.held && s.inbox.length &&
      (this.exchanges < this.maxExchanges || s.inbox.some((m) => m.from === 'user' || m.from === 'system')) && !this.stopped);
    if (ready) return;

    let reason = 'quiet';
    if (slots.every((s) => s.done)) reason = 'done';
    else if (slots.some((s) => s.asking)) reason = 'ask-user';
    else if (this.stopped || slots.some((s) => s.held)) reason = 'paused';
    else if (slots.some((s) => s.inbox.length) && this.exchanges >= this.maxExchanges) reason = 'limit';

    if (!this._emitRoom('idle', reason)) return;
    if (reason === 'limit') {
      this.chat('system', 'both', `Paused after ${this.maxExchanges} agent-to-agent messages without you. Send a message to keep them going.`, { kind: 'system' });
    } else if (reason === 'done') {
      this.chat('system', 'both', 'Both agents agree the task is complete.', { kind: 'system' });
    }
  }

  // ---- agent events -------------------------------------------------------
  _onAgentEvent(slot, ev) {
    const agent = slot.agent.id;
    switch (ev.t) {
      case 'usage':
        this._pushStats(false);
        return;
      case 'status':
        this._setSlotState(slot, ev.state, ev.label, true);
        return;
      case 'thinking_tokens':
        slot.thinkingTokens = ev.tokens || slot.thinkingTokens;
        this._emit({ ...ev, agent });
        return;
      case 'tool':
        if (ev.phase === 'start') slot.tools++;
        this._emit({ ...ev, agent });
        if (ev.phase === 'end') this._afterTool(slot, ev);
        return;
      default:
        this._emit({ ...ev, agent });
    }
  }

  _afterTool(slot, ev) {
    if (!ev.ok) return;
    let changes = [];
    try {
      const paths = ev.files && ev.files.length ? ev.files : ev.file ? [ev.file] : [];
      if (ev.kind === 'write' && paths.length) changes = this.ws.touch(paths);
      else if (['write', 'shell', 'other'].includes(ev.kind)) this._deferSweep(slot);
    } catch { /* never let diffing break a run */ }
    this._record(slot, changes);
  }

  /**
   * A shell command may have changed any file. Wait briefly before sweeping so the peer's own
   * exact-path tool events (which land milliseconds after its write) claim their files first;
   * otherwise a sweep here would credit the peer's edit to this agent.
   */
  _deferSweep(slot) {
    if (slot.sweepTimer) return;
    slot.sweepTimer = setTimeout(() => this._flushSweep(slot), 300);
  }

  _flushSweep(slot) {
    if (!slot.sweepTimer) return;
    clearTimeout(slot.sweepTimer);
    slot.sweepTimer = null;
    this._record(slot, this._safeSweep());
  }

  _safeSweep() {
    try { return this.ws.sweep(); } catch { return []; }
  }

  /** Attribute file changes to an agent: stats, conflict detection, UI event. */
  _record(slot, changes) {
    if (!changes.length) return;
    const id = slot.agent.id;
    for (const c of changes) {
      slot.add += c.add;
      slot.del += c.del;
      slot.files.add(c.rel);
      const claim = this.claims.get(c.file);
      const now = Date.now();
      if (claim && claim.agent !== id && now - claim.ts < CLAIM_TTL_MS) {
        const other = this.slots.get(claim.agent);
        const msg = `${slot.agent.label} edited ${c.rel}, which ${other.agent.label} changed ${Math.round((now - claim.ts) / 1000)}s ago.`;
        this.chat('system', 'both', `⚠ ${msg}`, { kind: 'conflict', file: c.rel });
        other.notes.push(`${msg} Re-read it before editing it again.`);
      }
      this.claims.set(c.file, { agent: id, ts: now });
    }
    this._emit({ t: 'change', agent: id, files: changes.map((c) => ({ file: c.rel, add: c.add, del: c.del, created: c.created })) });
    this._pushStats(true);
  }

  _setSlotState(slot, state, label, quiet) {
    if (slot.state === state && slot.label === label) return;
    slot.state = state;
    slot.label = label;
    this._emit({ t: 'status', agent: slot.agent.id, state, label });
    if (!quiet) this._pushStats(true);
  }

  _emitInbox(slot) {
    this._emit({ t: 'inbox', agent: slot.agent.id, count: slot.inbox.length, held: slot.held });
  }

  // ---- stats --------------------------------------------------------------
  snapshot() {
    const agents = {};
    for (const [id, s] of this.slots) {
      const u = s.agent.usage;
      agents[id] = {
        in: u.in, out: u.out, cached: u.cached, reasoning: u.reasoning, cost: u.cost,
        tokens: u.in + u.out,
        add: s.add, del: s.del, files: s.files.size, tools: s.tools, turns: s.agent.turns,
        activeMs: s.activeMs + (s.turnStart ? Date.now() - s.turnStart : 0),
        state: s.state, label: s.label, held: s.held, done: s.done, queued: s.inbox.length,
        thinkingTokens: s.thinkingTokens,
      };
    }
    return { agents, exchanges: this.exchanges, elapsedMs: this.started ? Date.now() - this.startedAt : 0 };
  }

  _pushStats(force) {
    if (force) {
      clearTimeout(this._statsTimer);
      this._statsTimer = null;
      this._emit({ t: 'stats', ...this.snapshot() });
      return;
    }
    if (this._statsTimer) return;
    this._statsTimer = setTimeout(() => {
      this._statsTimer = null;
      this._emit({ t: 'stats', ...this.snapshot() });
    }, 250);
  }

  dispose() {
    this.stopped = true;
    clearTimeout(this._statsTimer);
    for (const s of this.slots.values()) {
      clearTimeout(s.sweepTimer);
      if (s.agent.running) s.agent.interrupt();
    }
  }
}

function clip(text) {
  return text.length > MAX_FORWARD ? text.slice(0, MAX_FORWARD) + '\n…(truncated)' : text;
}

module.exports = { Room };
