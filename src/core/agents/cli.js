'use strict';
const { Agent } = require('./base');
const { resolveBin } = require('../proc');

/**
 * Generic adapter for any coding CLI that takes a prompt and prints plain text
 * (Gemini CLI, Aider, OpenCode, a wrapper script, ...). It has no structured
 * event stream, so there are no tool events or token counts: the panel shows
 * the streamed output, and lines changed come from diffing the workspace.
 *
 * Most such CLIs have no session resume, so each turn re-sends the system
 * prompt plus the last few exchanges; the shared files carry the real state.
 */
class CliAgent extends Agent {
  constructor(opts) {
    super(opts);
    this.noToolEvents = true;
    this.system = opts.system || '';
    this.commandName = opts.command || '';
    this.argsTemplate = opts.args || [];
    this.promptVia = opts.promptVia || 'stdin'; // 'stdin' | 'arg'
    this.modelFlag = opts.modelFlag === undefined ? '--model' : opts.modelFlag;
    this.bin = this.commandName ? resolveBin(this.commandName, opts.binPath) : null;
    this.history = [];
    this._pendingPrompt = '';
  }

  buildCommand(prompt) {
    if (!this.commandName) throw new Error(`${this.label}: no command configured.`);
    if (!this.bin) throw new Error(`\`${this.commandName}\` not found on PATH. Install it, or set the full path in the agent settings.`);
    const recent = this.history.slice(-6).map((h) => `${h.who}: ${h.text}`).join('\n\n');
    const full = [this.system, recent && `=== RECENT EXCHANGE ===\n${recent}`, `=== NEW MESSAGE ===\n${prompt}`].filter(Boolean).join('\n\n');
    this._pendingPrompt = prompt;
    const args = [...this.bin.prefix, ...this.argsTemplate.map((a) => a.replace('{cwd}', this.cwd))];
    if (this.model && this.modelFlag) args.push(this.modelFlag, this.model);
    if (this.promptVia === 'arg') args.push(full);
    return { command: this.bin.command, args, stdin: this.promptVia === 'stdin' ? full : null, shell: this.bin.shell };
  }

  handleRaw(line) {
    this._text = (this._text || '') + line + '\n';
    this.emitEv({ t: 'text', text: line, block: `t${this.turns}` });
    this.emitEv({ t: 'status', state: 'working', label: 'Working…' });
  }

  _finish(r) {
    const text = (this._text || '').trim();
    this._text = '';
    if (r.ok) {
      this._final = text;
      this.history.push({ who: 'peer/user', text: this._pendingPrompt.slice(0, 1500) }, { who: 'you', text: text.slice(0, 1500) });
      // no token counts available: rough estimate so the panel still moves
      this.turnUsage = { in: Math.ceil(this._pendingPrompt.length / 4), out: Math.ceil(text.length / 4), cached: 0, reasoning: 0, cost: 0 };
    }
    return super._finish(r);
  }
}

/** Ready-made configurations. The model flag/args differ per CLI; override in settings if yours differ. */
// NOTE: these presets are written from each tool's documented non-interactive mode and have not
// been run against the real CLIs; the generic adapter itself is covered by a simulated CLI test.
const PRESETS = {
  gemini: { command: 'gemini', args: ['--yolo', '-p', 'Follow the instructions given on stdin.'], promptVia: 'stdin', modelFlag: '--model' },
  aider: { command: 'aider', args: ['--yes-always', '--no-pretty', '--no-stream', '--message'], promptVia: 'arg', modelFlag: '--model' },
  opencode: { command: 'opencode', args: ['run'], promptVia: 'arg', modelFlag: '--model' },
};

module.exports = { CliAgent, PRESETS };
