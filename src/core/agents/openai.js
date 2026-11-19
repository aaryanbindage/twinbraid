'use strict';
const { Agent } = require('./base');
const { Toolbox } = require('./tools');

const MAX_STEPS = 40;

/** Streaming splitter that routes <think>…</think> to thinking, tolerating tags split across chunks. */
class ThinkSplitter {
  constructor() { this.inThink = false; this.tail = ''; }

  feed(chunk) {
    const out = [];
    let s = this.tail + chunk;
    this.tail = '';
    while (s) {
      const tag = this.inThink ? '</think>' : '<think>';
      const i = s.indexOf(tag);
      if (i >= 0) {
        if (i) out.push({ think: this.inThink, text: s.slice(0, i) });
        this.inThink = !this.inThink;
        s = s.slice(i + tag.length);
        continue;
      }
      // hold back a possible partial tag at the end
      let keep = 0;
      for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
        if (tag.startsWith(s.slice(-k))) { keep = k; break; }
      }
      if (s.length > keep) out.push({ think: this.inThink, text: s.slice(0, s.length - keep) });
      this.tail = s.slice(s.length - keep);
      break;
    }
    return out;
  }

  flush() {
    const t = this.tail;
    this.tail = '';
    return t ? [{ think: this.inThink, text: t }] : [];
  }
}

/**
 * Any OpenAI-compatible chat endpoint with tool calling: Ollama, LM Studio,
 * llama.cpp server, vLLM, OpenRouter, OpenAI... It runs its own agent loop
 * (read/write/edit/search/shell) so local models can really edit the project.
 */
class OpenAIAgent extends Agent {
  constructor(opts) {
    super(opts);
    // baseUrl may be a promise (the simulated server starts asynchronously)
    this._baseP = Promise.resolve(opts.baseUrl || 'http://localhost:11434/v1');
    this.baseUrl = typeof opts.baseUrl === 'string' ? opts.baseUrl.replace(/\/+$/, '') : '';
    this.apiKey = opts.apiKey || (opts.apiKeyEnv && process.env[opts.apiKeyEnv]) || '';
    this.system = opts.system || '';
    this.maxSteps = opts.maxSteps || MAX_STEPS;
    this.contextChars = opts.contextChars || 120000;
    this.temperature = opts.temperature;
    this.tools = new Toolbox({ cwd: this.cwd, permission: this.permission });
    this.messages = [{ role: 'system', content: this.system }];
    this.ac = null;
    this._seq = 0;
    this.noToolEvents = false;
  }

  interrupt() {
    if (!this.running) return false;
    this._interrupted = true;
    if (this.ac) this.ac.abort();
    this.tools.abort();
    return true;
  }

  async runTurn(prompt) {
    if (this.running) throw new Error(`${this.id} is already running a turn`);
    if (!this.model) {
      return this._finish({ ok: false, error: `${this.label}: no model set. Enter the model name (for Ollama, one of \`ollama list\`).` });
    }
    this.running = true;
    this._interrupted = false;
    this._final = '';
    this._tools.clear();
    this.turnUsage = { in: 0, out: 0, cached: 0, reasoning: 0, cost: 0 };
    this.turns++;
    this.emitEv({ t: 'turn', phase: 'start', n: this.turns });
    this.emitEv({ t: 'meta', model: this.model, session: 'local' });
    this.emitEv({ t: 'status', state: 'thinking', label: 'Starting…' });
    this.messages.push({ role: 'user', content: prompt });

    let nudges = 0;
    let usedTools = false;
    try {
      for (let step = 1; step <= this.maxSteps; step++) {
        const msg = await this._step();
        this.messages.push(msg);
        if (!msg.tool_calls || !msg.tool_calls.length) {
          // small models often announce the next action ("Let's write the test now") or paste a file as
          // markdown instead of calling Write, and end the turn with nothing done
          const pasted = !usedTools && hasCodeBlock(msg.content);
          if (nudges < 2 && (pasted || promisesAction(msg.content))) {
            nudges++;
            this.messages.push({
              role: 'user',
              content: pasted
                ? '[harness] Your reply contains code but you did not call a tool, so nothing was saved. Call the Write tool to create the file (and Bash to run it), then report briefly.'
                : '[harness] You described an action but did not call a tool. Call the tool now. If you are truly finished, say so plainly instead.',
            });
            this.emitEv({ t: 'status', state: 'thinking', label: 'Nudging model to act…' });
            continue;
          }
          this.setFinal(msg.content || '');
          break;
        }
        usedTools = true;
        for (const call of msg.tool_calls) {
          if (this._interrupted) throw new Error('aborted');
          await this._exec(call);
        }
        if (step === this.maxSteps) this.setFinal(`${msg.content || ''}\n(stopped after ${this.maxSteps} steps; ask me to continue)`.trim());
      }
      return this._finish({ ok: true });
    } catch (err) {
      if (this._interrupted) return this._finish({ ok: false, interrupted: true });
      return this._finish({ ok: false, error: this._explain(err) });
    }
  }

  _explain(err) {
    const m = String(err.message || err);
    if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(m + (err.cause ? err.cause.code : ''))) {
      return `Cannot reach ${this.baseUrl}. Is the server (Ollama, LM Studio, ...) running?`;
    }
    return m;
  }

  _trim() {
    const size = () => this.messages.reduce((n, m) => n + (m.content ? m.content.length : 0) + JSON.stringify(m.tool_calls || '').length, 0);
    if (size() <= this.contextChars) return;
    // first shrink old tool output, which is the bulk of any agent transcript
    for (let i = 1; i < this.messages.length - 6 && size() > this.contextChars; i++) {
      const m = this.messages[i];
      if (m.role === 'tool' && m.content.length > 400) m.content = `${m.content.slice(0, 300)}\n…[older output trimmed]`;
    }
    // then drop whole oldest exchanges, never leaving an orphaned tool message at the front
    while (size() > this.contextChars && this.messages.length > 8) {
      this.messages.splice(1, 1);
      while (this.messages[1] && this.messages[1].role !== 'user') this.messages.splice(1, 1);
    }
  }

  async _step() {
    this._trim();
    const stepId = ++this._seq;
    this.baseUrl = String(await this._baseP).replace(/\/+$/, '');
    this.ac = new AbortController();
    const body = {
      model: this.model,
      messages: this.messages,
      tools: this.tools.definitions(),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (this.temperature != null) body.temperature = this.temperature;
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: this.ac.signal,
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 600);
      if (res.status === 400 && /tool/i.test(text)) {
        throw new Error(`${this.model} does not support tool calling on this server, so it cannot edit files. Pick a tool-capable model (e.g. qwen2.5-coder, llama3.1, mistral-nemo). Server said: ${text}`);
      }
      if (res.status === 404 && /model/i.test(text)) throw new Error(`Model "${this.model}" not found on the server. ${text}`);
      throw new Error(`HTTP ${res.status} from ${this.baseUrl}: ${text}`);
    }

    const split = new ThinkSplitter();
    const calls = new Map(); // index -> { id, name, args }
    let content = '';
    let usage = null;
    let sawThink = false;
    let outChars = 0;

    const emitParts = (parts) => {
      for (const p of parts) {
        if (p.think) { sawThink = true; this.emitEv({ t: 'thinking', text: p.text, block: stepId }); } else {
          content += p.text;
          this.emitEv({ t: 'text', text: p.text, block: stepId });
        }
      }
    };

    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let o;
        try { o = JSON.parse(data); } catch { continue; }
        if (o.error) throw new Error(typeof o.error === 'string' ? o.error : o.error.message || 'server error');
        if (o.usage) usage = o.usage;
        const d = o.choices && o.choices[0] && o.choices[0].delta;
        if (!d) continue;
        const reasoning = d.reasoning_content || d.reasoning;
        if (reasoning) { sawThink = true; outChars += reasoning.length; this.emitEv({ t: 'thinking', text: reasoning, block: stepId }); }
        if (d.content) {
          outChars += d.content.length;
          emitParts(split.feed(d.content));
          this.emitEv({ t: 'status', state: split.inThink ? 'thinking' : 'writing', label: split.inThink ? 'Thinking…' : 'Writing…' });
        }
        for (const tc of d.tool_calls || []) {
          const idx = tc.index ?? 0;
          let c = calls.get(idx);
          if (!c) { c = { id: tc.id || `call_${stepId}_${idx}`, name: '', args: '', started: false }; calls.set(idx, c); }
          if (tc.id) c.id = tc.id;
          if (tc.function && tc.function.name) c.name += tc.function.name;
          if (tc.function && tc.function.arguments) { c.args += tc.function.arguments; outChars += tc.function.arguments.length; }
          if (c.name && !c.started) { c.started = true; this.toolStart(c.id, c.name, {}); }
        }
      }
    }
    emitParts(split.flush());

    // usage: trust the server, otherwise estimate from characters
    const u = usage || {};
    const promptTok = u.prompt_tokens != null ? u.prompt_tokens : Math.ceil(JSON.stringify(this.messages).length / 4);
    const outTok = u.completion_tokens != null ? u.completion_tokens : Math.ceil(outChars / 4);
    const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
    this.turnUsage.in += Math.max(0, promptTok - cached);
    this.turnUsage.cached += cached;
    this.turnUsage.out += outTok;
    this.turnUsage.reasoning += (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0;
    this.emitEv({ t: 'usage' });

    const msg = { role: 'assistant', content };
    if (calls.size) {
      msg.tool_calls = [...calls.values()].filter((c) => c.name).map((c) => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' },
      }));
    } else {
      // small local models often print the call as JSON text instead of using the tool API
      const names = new Set(this.tools.definitions().map((d) => d.function.name));
      const found = extractTextToolCalls(content, names);
      if (found.calls.length) {
        msg.content = found.text;
        msg.tool_calls = found.calls.map((c, i) => ({
          id: `txt_${this.turns}_${Date.now()}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        }));
      }
    }
    return msg;
  }

  async _exec(call) {
    const { id, function: fn } = call;
    let args;
    let parseErr = null;
    try { args = JSON.parse(fn.arguments || '{}'); } catch (e) { parseErr = e.message; args = {}; }
    if (!this._tools.has(id)) this.toolStart(id, fn.name, args);
    else this.toolUpdate(id, args);
    this.emitEv({ t: 'status', state: fn.name === 'Bash' ? 'working' : 'editing', label: this._tools.get(id) ? `${fn.name === 'Bash' ? 'Running' : fn.name === 'Read' ? 'Reading' : 'Editing'} ${this._tools.get(id).summary}` : fn.name });
    const r = parseErr
      ? { ok: false, output: `Invalid JSON arguments: ${parseErr}. Send valid JSON.` }
      : await this.tools.run(fn.name, args);
    this.toolEnd(id, r.ok);
    this.messages.push({ role: 'tool', tool_call_id: id, content: r.output });
  }
}

/** A fenced code block of real size (closed or cut off), i.e. a file pasted into chat. */
function hasCodeBlock(text) {
  return /```[\w.+-]*\n[\s\S]{60,}/.test(String(text || ''));
}

/** True when the final sentence promises an action instead of reporting a result. */
function promisesAction(text) {
  const t = String(text || '').replace(/\[\[[^\]]*\]\]/g, ' ').trim();
  if (!t || /\[\[\s*(done|ask)/i.test(String(text))) return false;
  const last = t.split(/(?<=[.!?:])\s+/).filter(Boolean).slice(-2).join(' ');
  return /\b(let'?s|let me|i will|i'll|i am going to|i'm going to|next,? i|now,? i|going to)\b/i.test(last);
}

/**
 * Find `{"name": "Write", "arguments": {...}}` objects printed in plain text (bare, in ``` fences or
 * <tool_call> tags). Only names the toolbox knows count. Returns the text with those objects removed.
 */
function extractTextToolCalls(text, names) {
  const calls = [];
  const cuts = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = j; break; }
    }
    if (end < 0) continue;
    try {
      const o = JSON.parse(text.slice(i, end + 1));
      const name = o.name || (o.function && o.function.name);
      let args = o.arguments !== undefined ? o.arguments : o.parameters !== undefined ? o.parameters : o.function && o.function.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
      if (names.has(name) && args && typeof args === 'object') {
        calls.push({ name, arguments: args });
        cuts.push([i, end + 1]);
        i = end;
      }
    } catch { /* not JSON, keep scanning */ }
  }
  if (!calls.length) return { calls, text };
  let out = '';
  let at = 0;
  for (const [s, e] of cuts) { out += text.slice(at, s); at = e; }
  out += text.slice(at);
  out = out.replace(/```(?:json)?\s*```/g, '').replace(/<\/?tool_call>/g, '').trim();
  return { calls, text: out };
}

module.exports = { OpenAIAgent, ThinkSplitter, extractTextToolCalls, promisesAction, hasCodeBlock };
