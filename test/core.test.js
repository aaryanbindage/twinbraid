'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseTurnEnd } = require('../src/core/protocol');
const { Workspace } = require('../src/core/workspace');
const { buildRoom } = require('../src/core/factory');
const { ClaudeAgent } = require('../src/core/agents/claude');
const { CodexAgent } = require('../src/core/agents/codex');
const { classifyTool } = require('../src/core/agents/base');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'duet-'));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 15)); }
  throw new Error('timed out waiting for condition');
};

test('protocol tags are parsed and stripped', () => {
  assert.deepStrictEqual(parseTurnEnd('All good [[done]]'), { done: true, wait: false, ask: false, body: 'All good' });
  assert.strictEqual(parseTurnEnd('hm [[Ask-User]] which db?').ask, true);
  assert.strictEqual(parseTurnEnd('[[wait]]').body, '');
  assert.strictEqual(parseTurnEnd('plain message').done, false);
});

test('classifyTool gives size hints for edits', () => {
  const c = classifyTool('Write', { file_path: 'a.js', content: 'a\nb\nc' });
  assert.deepStrictEqual(c.hint, { add: 3, del: 0 });
  assert.strictEqual(classifyTool('Bash', { command: 'npm   test' }).summary, 'npm test');
  assert.strictEqual(classifyTool('Glob', { pattern: '*.js' }).kind, 'search');
});

test('workspace attributes added and removed lines', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\ntwo\nthree\n');
  const ws = new Workspace(d);
  ws.snapshot();
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\nTWO\nthree\nfour\n');
  fs.writeFileSync(path.join(d, 'b.txt'), 'x\ny\n');
  const out = ws.sweep();
  const a = out.find((c) => c.rel === 'a.txt');
  const b = out.find((c) => c.rel === 'b.txt');
  assert.deepStrictEqual([a.add, a.del], [2, 1]);
  assert.deepStrictEqual([b.add, b.del, b.created], [2, 0, true]);
  fs.rmSync(path.join(d, 'b.txt'));
  assert.deepStrictEqual(ws.sweep().map((c) => [c.rel, c.del]), [['b.txt', 2]]);
});

test('claude stream-json: thinking, tool lifecycle, usage', () => {
  const a = new ClaudeAgent({ id: 'claude', cwd: process.cwd(), binPath: 'claude' });
  const evs = [];
  a.on('ev', (e) => evs.push(e));
  const feed = (o) => a.handleLine(o);
  feed({ type: 'system', subtype: 'init', session_id: 'S1', model: 'claude-x' });
  feed({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000 } } } });
  feed({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });
  feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } });
  feed({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Write', input: {} } } });
  feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path": "C:\\\\x\\\\a.js", "content": "l1\\nl2"}' } } });
  feed({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
  feed({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } });
  feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } });
  assert.strictEqual(a.sessionId, 'S1');
  assert.ok(evs.some((e) => e.t === 'thinking' && e.text === 'hmm'));
  const upd = evs.find((e) => e.t === 'tool' && e.phase === 'update' && e.hint);
  assert.deepStrictEqual(upd.hint, { add: 2, del: 0 });
  assert.strictEqual(upd.file, 'C:\\x\\a.js');
  const end = evs.find((e) => e.t === 'tool' && e.phase === 'end');
  assert.strictEqual(end.kind, 'write');
  assert.deepStrictEqual([a.usage.in, a.usage.out, a.usage.cached], [102, 40, 5000]);
  feed({ type: 'result', result: 'final text', session_id: 'S1', total_cost_usd: 0.5, usage: { input_tokens: 4, cache_creation_input_tokens: 200, cache_read_input_tokens: 9000, output_tokens: 90 } });
  assert.strictEqual(a._final, 'final text');
  assert.deepStrictEqual([a.usage.in, a.usage.out, a.usage.cost], [204, 90, 0.5]);
});

test('codex jsonl: items, file_change, usage', () => {
  const a = new CodexAgent({ id: 'codex', cwd: process.cwd(), binPath: 'codex' });
  const evs = [];
  a.on('ev', (e) => evs.push(e));
  const feed = (o) => a.handleLine(o);
  feed({ type: 'thread.started', thread_id: 'T1' });
  feed({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: '**Planning** the change' } });
  feed({ type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'npm test' } });
  feed({ type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'npm test', exit_code: 1 } });
  feed({ type: 'item.completed', item: { id: 'f', type: 'file_change', status: 'completed', changes: [{ path: 'src/a.js', kind: 'update' }] } });
  feed({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'all done [[done]]' } });
  feed({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 20 } });
  assert.strictEqual(a.threadId, 'T1');
  assert.ok(evs.find((e) => e.t === 'thinking' && e.text.startsWith('Planning')));
  assert.strictEqual(evs.find((e) => e.t === 'tool' && e.id === 'c' && e.phase === 'end').ok, false);
  const fc = evs.find((e) => e.t === 'tool' && e.id === 'f' && e.phase === 'end');
  assert.deepStrictEqual(fc.files, ['src/a.js']);
  assert.strictEqual(fc.kind, 'write');
  assert.strictEqual(a._final, 'all done [[done]]');
  assert.deepStrictEqual([a.usage.in, a.usage.out, a.usage.cached], [600, 50, 400]);
});

test('codex args: resume keeps config overrides and reads prompt from stdin', () => {
  const a = new CodexAgent({ id: 'codex', cwd: 'C:/p', binPath: 'codex', system: 'SYS' });
  const first = a.buildCommand('go', true);
  assert.ok(first.args.includes('-C') && first.stdin.startsWith('SYS'));
  a.threadId = 'T9';
  const next = a.buildCommand('more', false);
  assert.deepStrictEqual(next.args.slice(0, 1), ['exec']);
  assert.ok(next.args.includes('resume') && next.args.includes('T9') && next.stdin === 'more');
});

async function runDemo(opts = {}) {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'package.json'), '{}');
  const room = buildRoom({ cwd, demo: true, speed: 0.02, ...opts });
  const events = [];
  room.on('event', (e) => events.push(e));
  return { cwd, room, events };
}

test('demo run: agents split work, talk, finish together', async () => {
  const { cwd, room, events } = await runDemo();
  room.start('build a markdown converter');
  await until(() => events.some((e) => e.t === 'room' && e.reason === 'done'));
  const chat = events.filter((e) => e.t === 'chat').map((e) => `${e.from}>${e.to}:${e.kind}`);
  assert.strictEqual(chat[0], 'user>both:task');
  assert.deepStrictEqual(chat.filter((c) => c.endsWith(':agent')), ['claude>codex:agent', 'codex>claude:agent']);
  assert.ok(chat.includes('codex>null:note'), 'codex oriented then waited');
  assert.ok(fs.existsSync(path.join(cwd, 'src/parser.js')));
  assert.ok(fs.existsSync(path.join(cwd, 'src/render.js')));
  const s = room.snapshot().agents;
  assert.ok(s.claude.add > 70 && s.codex.add > 40, JSON.stringify(s));
  assert.ok(s.claude.tokens > 0 && s.codex.tokens > 0);
  assert.ok(events.some((e) => e.t === 'thinking' && e.agent === 'claude'));
  room.dispose();
});

test('interrupt + redirect: user message cuts in and is delivered', async () => {
  const { room, events } = await runDemo({ speed: 0.6 });
  room.start('build a markdown converter');
  await until(() => room.slots.get('claude').agent.running);
  room.send({ to: 'claude', text: 'use tabs not spaces', interrupt: true });
  await until(() => events.some((e) => e.t === 'chat' && e.from === 'claude' && /tabs/.test(e.text)), 15000);
  const turns = events.filter((e) => e.t === 'turn' && e.agent === 'claude' && e.phase === 'end');
  assert.ok(turns[0].interrupted, 'first claude turn was interrupted');
  room.dispose();
});

test('held agent queues messages, stays quiet, and wakes on resume', async () => {
  const { room, events } = await runDemo({ speed: 0.02 });
  room.start('task');
  await until(() => events.some((e) => e.t === 'room' && e.reason === 'done'));
  events.length = 0;
  room.interrupt('codex');
  room.send({ to: 'claude', text: 'also add a README' });
  await until(() => events.some((e) => e.t === 'chat' && e.from === 'claude' && e.to === 'codex'));
  assert.ok(!events.some((e) => e.t === 'turn' && e.agent === 'codex' && e.phase === 'start'), 'held codex did not start');
  assert.ok(room.slots.get('codex').inbox.length >= 1, "claude's message is queued for codex");
  room.resume('codex');
  await until(() => events.some((e) => e.t === 'turn' && e.agent === 'codex' && e.phase === 'start'));
  room.dispose();
});

test('broadcast reaches both agents and resets the exchange counter', async () => {
  const { room, events } = await runDemo({ speed: 0.02 });
  room.start('task');
  await until(() => events.some((e) => e.t === 'room' && e.reason === 'done'));
  events.length = 0;
  room.send({ to: 'both', text: 'switch to tabs' });
  await until(() => ['claude', 'codex'].every((a) => events.some((e) => e.t === 'chat' && e.from === a && /tabs/.test(e.text))));
  assert.strictEqual(events.find((e) => e.t === 'chat' && e.kind === 'user').to, 'both');
  room.dispose();
});

test('exchange limit pauses the room until the human speaks', async () => {
  const { room, events } = await runDemo({ maxExchanges: 1 });
  room.start('task');
  await until(() => events.some((e) => e.t === 'room' && e.reason === 'limit'));
  assert.ok(events.some((e) => e.t === 'chat' && e.kind === 'system' && /Paused after 1/.test(e.text)));
  room.dispose();
});
