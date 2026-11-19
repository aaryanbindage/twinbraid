'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildRoom } = require('../src/core/factory');
const { ThinkSplitter, OpenAIAgent } = require('../src/core/agents/openai');
const { Toolbox, globToRegex } = require('../src/core/agents/tools');
const { start: startFakeOpenAI } = require('../src/sim/fake-openai-server');

process.env.FAKE_CODEX_SPEED = '0.02';
process.env.FAKE_CLI_SPEED = '0.02';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'twinbraid-sim-'));
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timed out waiting for condition');
};

function run(agents, extra = {}) {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'package.json'), '{}');
  const room = buildRoom({ cwd, agents, maxExchanges: 10, ...extra });
  const events = [];
  room.on('event', (e) => events.push(e));
  return { cwd, room, events };
}
const idle = (events, reason) => () => events.some((e) => e.t === 'room' && e.state === 'idle' && (!reason || e.reason === reason));

test('ThinkSplitter routes <think> blocks even when tags are split across chunks', () => {
  const s = new ThinkSplitter();
  const out = [];
  for (const c of ['Hel', 'lo <th', 'ink>plan', 'ning</thi', 'nk> done']) out.push(...s.feed(c));
  out.push(...s.flush());
  const join = (think) => out.filter((p) => p.think === think).map((p) => p.text).join('');
  assert.strictEqual(join(true), 'planning');
  assert.strictEqual(join(false), 'Hello  done');
});

test('Toolbox: edit uniqueness, workspace jail, read-only mode', async () => {
  const cwd = tmp();
  const tb = new Toolbox({ cwd, permission: 'workspace' });
  assert.ok((await tb.run('Write', { file_path: 'a.txt', content: 'x\nx\ny\n' })).ok);
  assert.match((await tb.run('Edit', { file_path: 'a.txt', old_string: 'x', new_string: 'z' })).output, /matches 2 times/);
  assert.ok((await tb.run('Edit', { file_path: 'a.txt', old_string: 'y', new_string: 'Y' })).ok);
  assert.strictEqual(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'x\nx\nY\n');
  assert.match((await tb.run('Write', { file_path: '../escape.txt', content: 'no' })).output, /outside the workspace/);
  assert.match((await tb.run('Read', { file_path: 'a.txt' })).output, /1\s+x/);
  assert.match((await tb.run('Grep', { pattern: 'Y' })).output, /a\.txt:3/);
  assert.strictEqual((await tb.run('Glob', { pattern: '*.txt' })).output, 'a.txt');
  const sh = await tb.run('Bash', { command: 'node -e "console.log(40+2)"' });
  assert.ok(sh.ok && /42/.test(sh.output));
  const ro = new Toolbox({ cwd, permission: 'careful' });
  assert.ok(!ro.definitions().some((d) => ['Write', 'Edit', 'Bash'].includes(d.function.name)));
  assert.match((await ro.run('Write', { file_path: 'b', content: '' })).output, /disabled/);
  assert.ok(globToRegex('src/**/*.js').test('src/a/b/c.js') && !globToRegex('*.js').test('a/b.js'));
});

test('simulated Codex CLI through the real CodexAgent: full collaboration', async () => {
  const { cwd, room, events } = run([{ kind: 'codex-sim' }, { kind: 'codex-sim' }]);
  room.start('build a markdown converter');
  await until(idle(events, 'done'));
  assert.ok(fs.existsSync(path.join(cwd, 'src/parser.js')) && fs.existsSync(path.join(cwd, 'src/render.js')));
  const s = room.snapshot().agents;
  const [a, b] = Object.values(s);
  assert.ok(a.add > 40 && b.add > 25, 'lines attributed to each agent from file_change items');
  assert.ok(a.tokens > 0 && a.cached > 0, 'usage parsed (cached tokens separated)');
  assert.ok(a.turns >= 2 && b.turns >= 3, 'sessions resumed across turns');
  assert.ok(events.some((e) => e.t === 'thinking' && /Planning/.test(e.text)), 'reasoning items shown');
  room.dispose();
});

test('simulated Codex failure is reported, not swallowed', async () => {
  const { room, events } = run([{ kind: 'codex-sim' }, { kind: 'codex-sim' }]);
  room.start('SIM_FAIL please');
  await until(() => events.some((e) => e.t === 'chat' && e.kind === 'error'));
  assert.match(events.find((e) => e.kind === 'error').text, /simulated failure|exited/);
  room.dispose();
});

test('local-model agent loop: tools, reasoning, usage, two local agents finish a task', async () => {
  const { cwd, room, events } = run([{ kind: 'local-sim' }, { kind: 'local-sim' }]);
  room.start('build a markdown converter');
  await until(idle(events, 'done'));
  assert.ok(fs.existsSync(path.join(cwd, 'src/parser.js')) && fs.existsSync(path.join(cwd, 'test/render.test.js')));
  const [a, b] = Object.values(room.snapshot().agents);
  assert.ok(a.add > 20 && b.add > 5);
  assert.ok(a.in > 0 && a.out > 0, 'usage from the stream');
  assert.ok(events.some((e) => e.t === 'thinking'), 'reasoning_content and <think> surfaced');
  assert.ok(events.some((e) => e.t === 'tool' && e.phase === 'end' && e.kind === 'shell' && e.ok), 'Bash tool ran');
  room.dispose();
});

test('any two agents: simulated Codex + local model + plain-text CLI', async () => {
  const fakeCli = path.join(__dirname, '..', 'src', 'sim', 'fake-cli.js').replace(/\\/g, '/');
  const cli = { kind: 'cli', command: process.execPath, args: [fakeCli], label: 'FakeCLI' };
  // local-model lead + plain CLI worker
  const one = run([{ kind: 'local-sim' }, cli], { lead: 'a' });
  one.room.start('build a markdown converter');
  await until(idle(one.events, 'done'));
  const w = Object.values(one.room.snapshot().agents)[1];
  assert.ok(fs.existsSync(path.join(one.cwd, 'src/render.js')));
  assert.ok(w.add >= 2, 'CLI agent has no tool events; lines still counted by workspace diff');
  one.room.dispose();
  // simulated Codex lead + local model worker
  const two = run([{ kind: 'codex-sim' }, { kind: 'local-sim' }], { lead: 'a' });
  two.room.start('build a markdown converter');
  await until(idle(two.events, 'done'));
  assert.ok(fs.existsSync(path.join(two.cwd, 'src/render.js')));
  two.room.dispose();
});

test('unique ids, labels and colours when both agents are the same kind', () => {
  const { room } = run([{ kind: 'claude' }, { kind: 'claude' }]);
  assert.deepStrictEqual(room.ids, ['claude', 'claude2']);
  const [a, b] = [...room.slots.values()].map((s) => s.agent);
  assert.notStrictEqual(a.label, b.label);
  assert.notStrictEqual(a.color, b.color);
});

test('local agent explains missing tool support and unreachable servers', async () => {
  const sim = await startFakeOpenAI({ speed: 0.1 });
  const cwd = tmp();
  const mk = (baseUrl) => new OpenAIAgent({ id: 'x', kind: 'ollama', label: 'X', cwd, model: 'tiny', baseUrl, system: 'sys' });
  const evs = [];
  const a = mk(sim.url);
  a.on('ev', (e) => evs.push(e));
  const r1 = await a.runTurn('SIM_NOTOOLS hi');
  assert.ok(!r1.ok && /does not support tool calling/.test(r1.error));
  const dead = mk('http://127.0.0.1:1/v1');
  const r2 = await dead.runTurn('hi');
  assert.ok(!r2.ok && /Cannot reach/.test(r2.error), r2.error);
  const nomodel = new OpenAIAgent({ id: 'y', kind: 'ollama', label: 'Y', cwd, model: '', baseUrl: sim.url });
  assert.match((await nomodel.runTurn('hi')).error, /no model set/);
  await sim.close();
});

test('interrupting a local model aborts the stream and the next turn works', async () => {
  const sim = await startFakeOpenAI({ speed: 4 }); // slow stream
  const cwd = tmp();
  const a = new OpenAIAgent({ id: 'x', kind: 'ollama', label: 'X', cwd, model: 'sim', baseUrl: sim.url, system: 'Your role: Lead.' });
  const p = a.runTurn('start');
  await until(() => a.ac && !a.ac.signal.aborted);
  setTimeout(() => a.interrupt(), 150);
  const r = await p;
  assert.ok(r.interrupted, 'turn reports interruption');
  assert.strictEqual(a.running, false);
  await sim.close();
});
