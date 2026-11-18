'use strict';
const { Agent } = require('./base');
const { resolveClaude } = require('../proc');

const PERMISSION = {
  // edits auto-approved, shell allowed, no prompts (headless can't answer them)
  workspace: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash', 'PowerShell'],
  careful: ['--permission-mode', 'acceptEdits'],
  full: ['--permission-mode', 'bypassPermissions'],
};

class ClaudeAgent extends Agent {
  constructor(opts) {
    super({ ...opts, kind: 'claude' });
    this.bin = opts.bin || resolveClaude(opts.binPath);
    this.system = opts.system || '';
    this.blocks = new Map(); // content block index -> { type, id, json }
    this.msgOut = 0;
    this.msgSeq = 0;
  }

  buildCommand(prompt) {
    if (!this.bin) throw new Error('Claude Code CLI not found. Install it and make sure `claude` is on PATH.');
    const args = [
      ...this.bin.prefix,
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...(PERMISSION[this.permission] || PERMISSION.workspace),
    ];
    if (this.model) args.push('--model', this.model);
    if (this.sessionId) args.push('--resume', this.sessionId);
    if (this.system) args.push('--append-system-prompt', this.system);
    // ask for readable thinking summaries so the UI can show them
    args.push('--settings', '{"showThinkingSummaries":true}');
    return { command: this.bin.command, args, stdin: prompt };
  }

  handleLine(o) {
    switch (o.type) {
      case 'system':
        if (o.subtype === 'init') {
          this.sessionId = o.session_id;
          if (o.model && !this.model) this.model = o.model;
          this.emitEv({ t: 'meta', model: o.model || this.model, session: o.session_id });
        } else if (o.subtype === 'thinking_tokens') {
          this.emitEv({ t: 'thinking_tokens', tokens: o.estimated_tokens });
        }
        break;
      case 'stream_event':
        this._stream(o.event || {});
        break;
      case 'user': {
        const content = o.message && o.message.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'tool_result') this.toolEnd(c.tool_use_id, !c.is_error);
          }
        }
        this.emitEv({ t: 'status', state: 'thinking', label: 'Thinking…' });
        break;
      }
      case 'result':
        this._sawResult = true;
        if (typeof o.result === 'string') this.setFinal(o.result);
        if (o.session_id) this.sessionId = o.session_id;
        this._commitResult(o);
        if (o.is_error) this._failed = typeof o.result === 'string' && o.result ? o.result : 'Claude reported an error';
        break;
      default:
        if (o.total_cost_usd !== undefined && o.usage) { this._sawResult = true; this._commitResult(o); }
    }
  }

  _commitResult(o) {
    const u = o.usage || {};
    // authoritative totals for the turn replace the live estimate
    this.turnUsage = {
      in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      out: u.output_tokens || 0,
      cached: u.cache_read_input_tokens || 0,
      reasoning: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
      cost: o.total_cost_usd || 0,
    };
    this.emitEv({ t: 'usage' });
  }

  _stream(e) {
    switch (e.type) {
      case 'message_start': {
        const u = (e.message && e.message.usage) || {};
        this.turnUsage.in += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        this.turnUsage.cached += u.cache_read_input_tokens || 0;
        this.msgOut = 0;
        this.msgSeq++;
        this.emitEv({ t: 'usage' });
        break;
      }
      case 'message_delta': {
        const out = (e.usage && e.usage.output_tokens) || 0;
        this.turnUsage.out += Math.max(0, out - this.msgOut);
        this.msgOut = out;
        this.emitEv({ t: 'usage' });
        break;
      }
      case 'content_block_start': {
        const b = e.content_block || {};
        this.blocks.set(e.index, { type: b.type, id: b.id, json: '' });
        if (b.type === 'thinking') this.emitEv({ t: 'status', state: 'thinking', label: 'Thinking…' });
        else if (b.type === 'text') this.emitEv({ t: 'status', state: 'writing', label: 'Writing…' });
        else if (b.type === 'tool_use') this.toolStart(b.id, b.name, b.input || {});
        break;
      }
      case 'content_block_delta': {
        const d = e.delta || {};
        const blk = this.blocks.get(e.index);
        if (d.type === 'thinking_delta' && d.thinking) this.emitEv({ t: 'thinking', text: d.thinking, block: `${this.msgSeq}.${e.index}` });
        else if (d.type === 'text_delta') this.emitEv({ t: 'text', text: d.text, block: `${this.msgSeq}.${e.index}` });
        else if (d.type === 'input_json_delta' && blk) {
          blk.json += d.partial_json || '';
          // surface the target file as soon as the path has streamed in
          if (!blk.early) {
            const m = /"(?:file_path|path|notebook_path)"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(blk.json);
            if (m) {
              blk.early = true;
              try { this.toolUpdate(blk.id, { file_path: JSON.parse(`"${m[1]}"`) }); } catch { /* partial */ }
            }
          }
        }
        break;
      }
      case 'content_block_stop': {
        const blk = this.blocks.get(e.index);
        if (blk && blk.type === 'tool_use') {
          try { this.toolUpdate(blk.id, JSON.parse(blk.json || '{}')); } catch { /* ignore */ }
        }
        this.blocks.delete(e.index);
        break;
      }
      default:
    }
  }
}

module.exports = { ClaudeAgent };


