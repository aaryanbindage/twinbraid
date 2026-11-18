#!/usr/bin/env node
'use strict';
/**
 * Simulated `codex` CLI. Speaks the same surface Duet uses:
 *   codex --version | codex login status
 *   codex exec [resume <thread>] [-c k=v ...] --json --skip-git-repo-check [-C dir] -   (prompt on stdin)
 * and emits the `codex exec --json` JSONL event stream (thread.started, item.*, turn.completed),
 * performing real file writes so the rest of Duet behaves exactly as with the real thing.
 *
 * FAKE_CODEX_SPEED scales delays (tests use 0.02). A prompt containing SIM_FAIL makes the turn fail.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const argv = process.argv.slice(2);
const speed = Number(process.env.FAKE_CODEX_SPEED || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * speed));
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (argv.includes('--version')) { console.log('codex-cli 0.0.0-sim'); process.exit(0); }
if (argv[0] === 'login' && argv[1] === 'status') { console.log('Logged in using ChatGPT (simulated)'); process.exit(0); }
if (argv[0] !== 'exec') { console.error('fake-codex: unsupported command'); process.exit(2); }

// `resume [OPTIONS] <SESSION_ID> [PROMPT]`: the id is the first positional after the options
const resumeIdx = argv.indexOf('resume');
function resumeId() {
  const takesValue = new Set(['-c', '--config', '-m', '--model', '-C', '--cd', '-s', '--sandbox']);
  for (let i = resumeIdx + 1; i < argv.length; i++) {
    if (takesValue.has(argv[i])) { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    return argv[i];
  }
  return null;
}
const threadId = (resumeIdx >= 0 && resumeId()) || `sim-${crypto.randomUUID()}`;
const cdIdx = argv.indexOf('-C');
const cwd = cdIdx >= 0 ? argv[cdIdx + 1] : process.cwd();
const stateFile = path.join(os.tmpdir(), `duet-fakecodex-${threadId}.json`);

let item = 0;
const id = () => `item_${item++}`;

async function reasoning(text) {
  await sleep(350);
  emit({ type: 'item.completed', item: { id: id(), type: 'reasoning', text } });
}
async function command(cmd, out = '', code = 0) {
  const i = id();
  emit({ type: 'item.started', item: { id: i, type: 'command_execution', command: cmd, aggregated_output: '', exit_code: null, status: 'in_progress' } });
  await sleep(500);
  emit({ type: 'item.completed', item: { id: i, type: 'command_execution', command: cmd, aggregated_output: out, exit_code: code, status: code === 0 ? 'completed' : 'failed' } });
}
async function writeFile(rel, content) {
  const abs = path.resolve(cwd, rel);
  const existed = fs.existsSync(abs);
  await sleep(600);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  emit({ type: 'item.completed', item: { id: id(), type: 'file_change', changes: [{ path: abs, kind: existed ? 'update' : 'add' }], status: 'completed' } });
}
const message = (text) => emit({ type: 'item.completed', item: { id: id(), type: 'agent_message', text } });

const RENDER = `'use strict';\nconst { parse } = require('./parser');\n${Array.from({ length: 30 }, (_, i) => `const h${i} = (t) => '<h${(i % 6) + 1}>' + t + '</h${(i % 6) + 1}>';`).join('\n')}\nmodule.exports = { render: (src) => parse(src).map((t) => (t.level ? h0(t.text) : '<p>' + t.text + '</p>')).join('') };\n`;
const PARSER = `'use strict';\n${Array.from({ length: 50 }, (_, i) => `const rule${i} = (l) => (l.startsWith('${'#'.repeat((i % 6) + 1)} ') ? { level: ${(i % 6) + 1}, text: l.slice(${(i % 6) + 2}) } : null);`).join('\n')}\nmodule.exports = { parse: (s) => s.split('\\n').map((l) => rule0(l) || { text: l }) };\n`;

async function main() {
  const prompt = fs.readFileSync(0, 'utf8');
  let st = { turns: 0, role: 'worker' };
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first turn */ }
  if (/Your role: Lead\./.test(prompt)) st.role = 'lead';
  else if (/Your role: Equal peer\./.test(prompt)) st.role = 'peer';
  st.turns++;

  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'turn.started' });

  if (/SIM_FAIL/.test(prompt)) {
    await sleep(200);
    emit({ type: 'turn.failed', error: { message: 'simulated failure' } });
    process.exit(1);
  }

  let usage = { input_tokens: 4200 + st.turns * 900, cached_input_tokens: 3000, output_tokens: 300 };
  const userMsg = st.turns > 1 && /\[from user\]\s*([^\n]*)/.exec(prompt);

  if (userMsg) {
    await reasoning(`**Reacting to the supervisor**\nThe supervisor said "${userMsg[1]}". I'll adjust my plan before touching anything.`);
    message(`Understood: ${userMsg[1]}. Adjusting; I'll tell the peer.`);
  } else if (st.role === 'lead') {
    if (st.turns === 1) {
      await reasoning('**Planning the split**\nI take the parser; the peer takes render + tests. Checking the repo first.');
      await command('ls -la', 'package.json');
      await writeFile('src/parser.js', PARSER);
      message('Plan: I own src/parser.js (done, parse(src) -> [{level?,text}]). Please build src/render.js and test/render.test.js, run them, and report.');
    } else {
      await reasoning('**Review**\nThe peer reports green. Verifying the suite myself.');
      await command('node --test', 'pass 1');
      message('Reviewed and ran the suite: green. [[done]] Markdown converter complete.');
    }
  } else if (st.turns === 1) {
    await reasoning('**Orienting**\nFirst turn is read-only; I will look around and wait for the plan.');
    await command('ls -la', 'package.json');
    message('[[silent]]');
  } else if (st.turns === 2) {
    await reasoning('**Implementing my part**\nThe lead owns src/parser.js, so I only touch render.js and the test.');
    await writeFile('src/render.js', RENDER);
    await writeFile('test/render.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\nconst { render } = require('../src/render');\ntest('heading', () => assert.match(render('# hi'), /<h1>hi<\\/h1>/));\n");
    await command('node --test', 'pass 1');
    message('render.js and its test are written; suite green. Over to you for review.');
  } else {
    await reasoning('**Wrapping up**\nLead approved; nothing left on my side.');
    message('Agreed, all green. [[done]]');
  }

  fs.writeFileSync(stateFile, JSON.stringify(st));
  emit({ type: 'turn.completed', usage });
}

main().catch((e) => { console.error(e); process.exit(1); });
