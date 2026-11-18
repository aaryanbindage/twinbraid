#!/usr/bin/env node
'use strict';
/**
 * Headless Duet: same engine as the desktop app, rendered as a terminal log.
 *   node src/cli.js --cwd . --task "add a /health endpoint with tests"
 * While running, type:  text = broadcast   @claude text = one agent   !claude text = interrupt + send
 *                       /stop = stop all   /resume claude   /quit
 */
const readline = require('node:readline');
const path = require('node:path');
const { buildRoom } = require('./core/factory');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (flag('help') || (!opt('task') && !flag('demo'))) {
  console.log(`Usage: duet-cli --task "<what to build>" [--cwd DIR] [--lead claude|codex|none]
                [--perm workspace|careful|full] [--max N] [--claude-model M] [--codex-model M]
                [--thinking] [--demo]`);
  process.exit(flag('help') ? 0 : 1);
}

const C = { claude: '\x1b[38;5;173m', codex: '\x1b[38;5;78m', user: '\x1b[38;5;110m', dim: '\x1b[2m', warn: '\x1b[33m', bad: '\x1b[31m', ok: '\x1b[32m', off: '\x1b[0m' };
const paint = (id, s) => `${C[id] || ''}${s}${C.off}`;
const clip = (s, n = 110) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const demo = flag('demo');
const cwd = demo ? require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'duet-demo-')) : path.resolve(opt('cwd', '.'));
const task = opt('task', 'Build a small markdown-to-HTML converter with tests.');
const room = buildRoom({
  cwd,
  demo,
  lead: opt('lead', 'claude'),
  permission: opt('perm', 'workspace'),
  maxExchanges: Number(opt('max', 14)),
  agents: [
    { id: 'claude', kind: 'claude', model: opt('claude-model', '') },
    { id: 'codex', kind: 'codex', model: opt('codex-model', '') },
  ],
});

let exitCode = 0;
const interactive = process.stdin.isTTY;
const thinking = flag('thinking');

room.on('event', (e) => {
  switch (e.t) {
    case 'session': console.log(`${C.dim}workspace ${e.cwd}  (${e.files} files tracked)${C.off}`); break;
    case 'chat':
      if (e.kind === 'note') console.log(`${C.dim}  ${e.from}: ${clip(e.text)}${C.off}`);
      else if (['system', 'interrupt', 'conflict', 'error'].includes(e.kind) || e.from === 'system') console.log(`${e.kind === 'error' ? C.bad : C.warn}  ! ${e.text}${C.off}`);
      else console.log(`\n${paint(e.from, `${e.from} → ${e.to}`)}${e.kind === 'ask' ? `${C.warn} (needs you)${C.off}` : ''}\n${e.text.replace(/^/gm, '  ')}`);
      break;
    case 'tool':
      if (e.phase === 'end') console.log(`${C.dim}  ${paint(e.agent, e.agent)} ${e.kind === 'write' ? '✎' : e.kind === 'shell' ? '$' : '·'} ${clip(e.summary || e.name)} ${e.ok ? '' : '(failed)'}${C.off}`);
      break;
    case 'change':
      for (const f of e.files) console.log(`  ${paint(e.agent, e.agent)} ${f.file} ${C.ok}+${f.add}${C.off} ${C.bad}-${f.del}${C.off}`);
      break;
    case 'thinking': if (thinking) process.stdout.write(`${C.dim}${e.text}${C.off}`); break;
    case 'room':
      if (e.state === 'idle') {
        console.log(`\n${C.dim}— idle (${e.reason}) —${C.off}`);
        if (e.reason === 'done' || !interactive) finish(e.reason === 'done' ? 0 : 2);
      }
      break;
    default:
  }
});

function summary() {
  const s = room.snapshot();
  console.log(`\n${C.dim}elapsed ${(s.elapsedMs / 1000).toFixed(0)}s · ${s.exchanges} agent-to-agent messages${C.off}`);
  for (const [id, a] of Object.entries(s.agents)) {
    console.log(`  ${paint(id, id.padEnd(7))} tokens ${String(a.tokens).padStart(8)}  lines +${a.add} -${a.del}  files ${a.files}  tools ${a.tools}  turns ${a.turns}${a.cost ? `  $${a.cost.toFixed(3)}` : ''}`);
  }
}

function finish(code) {
  exitCode = code;
  summary();
  room.dispose();
  setTimeout(() => process.exit(exitCode), 100);
}

if (interactive) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    if (t === '/quit') return finish(0);
    if (t === '/stop') return room.stopAll();
    let m = /^\/resume\s+(\w+)/.exec(t);
    if (m) return room.resume(m[1]);
    m = /^([@!])(\w+)\s+([\s\S]+)/.exec(t);
    if (m) return room.send({ to: m[2], text: m[3], interrupt: m[1] === '!' });
    room.send({ to: 'both', text: t });
  });
}
process.on('SIGINT', () => finish(130));

console.log(`${C.dim}task: ${task}${C.off}`);
room.start(task);
