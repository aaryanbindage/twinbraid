'use strict';
const { Agent } = require('./base');
const { resolveCodex } = require('../proc');

const SANDBOX = { workspace: 'workspace-write', careful: 'read-only', full: 'danger-full-access' };

/**
 * Codex CLI adapter (`codex exec --json`). The JSONL stream reports whole
 * items (reasoning summaries, commands, file changes, messages) rather than
 * token deltas, so activity updates at item granularity.
 */
class CodexAgent extends Agent {
  constructor(opts) {
    super({ ...opts, kind: 'codex' });
    this.bin = opts.bin || resolveCodex(opts.binPath);
    this.threadId = null;
    this.system = opts.system || '';
  }

  buildCommand(prompt, first) {
    if (!this.bin) throw new Error('Codex CLI not found. Run `npm i -g @openai/codex` and `codex login`.');
    const cfg = ['-c', `sandbox_mode="${SANDBOX[this.permission] || SANDBOX.workspace}"`, '-c', 'approval_policy="never"'];
    if (this.model) cfg.push('-m', this.model);
    const args = [...this.bin.prefix, 'exec'];
    if (this.threadId) args.push('resume', ...cfg, '--json', '--skip-git-repo-check', this.threadId, '-');
    else args.push(...cfg, '--json', '--skip-git-repo-check', '-C', this.cwd, '-');
    // Codex has no system-prompt flag, so the protocol rides along on turn 1.
    const text = first && this.system ? `${this.system}\n\n${prompt}` : prompt;
    return { command: this.bin.command, args, stdin: text, env: this.bin.env };
  }

  handleLine(o) {
    const item = o.item || {};
    switch (o.type) {
      case 'thread.started':
        this.threadId = o.thread_id;
        this.sessionId = o.thread_id;
        this.emitEv({ t: 'meta', model: this.model || 'codex', session: o.thread_id });
        break;
      case 'turn.started':
        this.emitEv({ t: 'status', state: 'thinking', label: 'Thinking…' });
        break;
      case 'item.started':
        this._item(item, 'start');
        break;
      case 'item.updated':
        break;
      case 'item.completed':
        this._item(item, 'end');
        break;
      case 'turn.completed': {
        this._sawResult = true;
        const u = o.usage || {};
        const cached = u.cached_input_tokens || 0;
        this.turnUsage = {
          in: Math.max(0, (u.input_tokens || 0) - cached),
          out: u.output_tokens || 0,
          cached,
          reasoning: u.reasoning_output_tokens || 0,
          cost: 0,
        };
        this.emitEv({ t: 'usage' });
        break;
      }
      case 'turn.failed':
        this._sawResult = true;
        this._failed = (o.error && o.error.message) || 'Codex turn failed';
        break;
      case 'error':
        this._failed = o.message || 'Codex error';
        break;
      default:
    }
  }

  _item(item, phase) {
    const id = item.id || `${item.type}-${Date.now()}`;
    switch (item.type) {
      case 'reasoning':
        if (phase === 'end' && item.text) this.emitEv({ t: 'thinking', text: item.text.replace(/\*\*/g, '') + '\n', block: id });
        break;
      case 'agent_message':
        if (phase === 'end') {
          this.setFinal(item.text || '');
          this.emitEv({ t: 'text', text: item.text || '', block: id });
        } else this.emitEv({ t: 'status', state: 'writing', label: 'Writing…' });
        break;
      case 'command_execution':
        if (phase === 'start') this.toolStart(id, 'command', { command: item.command });
        else this.toolEnd(id, item.exit_code === 0 || item.exit_code == null);
        break;
      case 'file_change': {
        const files = (item.changes || []).map((c) => c.path).filter(Boolean);
        if (phase === 'start') {
          this.toolStart(id, 'edit', { file_path: files[0] });
        } else {
          if (!this._tools.has(id)) this.toolStart(id, 'edit', { file_path: files[0] });
          this.toolEnd(id, item.status !== 'failed', { files, file: files[0] || null, summary: files.join(', ') });
        }
        break;
      }
      case 'mcp_tool_call':
        if (phase === 'start') this.toolStart(id, 'mcp', { query: `${item.server}.${item.tool}` });
        else this.toolEnd(id, item.status !== 'failed');
        break;
      case 'web_search':
        if (phase === 'start') this.toolStart(id, 'websearch', { query: item.query });
        else this.toolEnd(id, true);
        break;
      case 'todo_list':
        if (phase === 'end') this.emitEv({ t: 'status', state: 'working', label: 'Updating plan' });
        break;
      case 'error':
        this.emitEv({ t: 'log', level: 'warn', text: item.message || 'Codex warning' });
        break;
      default:
    }
  }
}

module.exports = { CodexAgent };
