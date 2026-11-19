#!/usr/bin/env node
'use strict';
/**
 * Simulated OpenAI-compatible server (what Ollama / LM Studio / llama.cpp expose).
 * Streams /v1/chat/completions as SSE with tool calls, reasoning, <think> tags and a usage
 * chunk, scripted so two instances can collaborate on a small task without any model.
 *
 *   node src/sim/fake-openai-server.js --port 11500
 */
const http = require('node:http');

const PARSER = `'use strict';\n${Array.from({ length: 30 }, (_, i) => `const rule${i} = (l) => (l.startsWith('${'#'.repeat((i % 6) + 1)} ') ? { level: ${(i % 6) + 1}, text: l.slice(${(i % 6) + 2}) } : null);`).join('\n')}\nmodule.exports = { parse: (s) => s.split('\\n').map((l) => rule0(l) || { text: l }) };\n`;
const RENDER = `'use strict';\nconst { parse } = require('./parser');\nmodule.exports = { render: (s) => parse(s).map((t) => (t.level ? '<h' + t.level + '>' + t.text + '</h' + t.level + '>' : '<p>' + t.text + '</p>')).join('') };\n`;
const TEST = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { render } = require('../src/render');\ntest('heading', () => assert.match(render('# hi'), /<h1>hi<\\/h1>/));\n";

const tool = (name, args) => ({ tool: { name, args } });

/** Decide the next assistant action from the transcript. Deterministic, stateless. */
function plan(messages, delayScale) {
  const sys = (messages[0] && messages[0].content) || '';
  const role = /Your role: Lead\./.test(sys) ? 'lead' : 'worker';
  let lastUser = -1;
  messages.forEach((m, i) => { if (m.role === 'user') lastUser = i; });
  const turnNo = messages.filter((m) => m.role === 'user').length;
  const toolsThisTurn = messages.slice(lastUser + 1).filter((m) => m.role === 'tool').length;
  const userText = messages[lastUser] ? messages[lastUser].content : '';
  const redirect = turnNo > 1 && /\[from user\]\s*([^\n]*)/.exec(userText);

  if (/SIM_NOTOOLS/.test(userText)) return { error: { status: 400, body: { error: { message: 'registry.ollama.ai/library/tiny does not support tools' } } } };
  // a model that announces work instead of doing it; only the harness nudge gets it to act
  if (messages.some((m) => m.role === 'user' && /SIM_NARRATE/.test(m.content))) {
    if (/^\[harness\]/.test(userText) && toolsThisTurn === 0) return tool('Write', { file_path: 'note.txt', content: 'hello\n' });
    if (toolsThisTurn > 0) return { text: 'note.txt written.' };
    return { text: "I understand. Let's write the file now." };
  }
  if (redirect) return { think: `The supervisor said "${redirect[1]}", so I should adapt.`, text: `Understood: ${redirect[1]}.` };

  if (role === 'lead') {
    if (turnNo === 1) {
      if (toolsThisTurn === 0) return { think: 'I take the parser, the peer takes render and tests.', ...tool('LS', { path: '.' }) };
      if (toolsThisTurn === 1) return { ...tool('Write', { file_path: 'src/parser.js', content: PARSER }) };
      return { text: 'Plan: I own src/parser.js (done). Please write src/render.js and test/render.test.js, run them, and report.' };
    }
    if (toolsThisTurn === 0) return { think: 'Peer says it is done; verifying.', ...tool('Bash', { command: 'node --test' }) };
    return { text: 'Reviewed and ran the suite: green. [[done]] Markdown converter complete.' };
  }
  if (turnNo === 1) return { text: '<think>First turn is orientation only.</think>[[silent]]' };
  if (turnNo === 2) {
    if (toolsThisTurn === 0) return { think: 'I only touch render.js and the test.', ...tool('Write', { file_path: 'src/render.js', content: RENDER }) };
    if (toolsThisTurn === 1) return tool('Write', { file_path: 'test/render.test.js', content: TEST });
    if (toolsThisTurn === 2) return tool('Bash', { command: 'node --test' });
    return { text: 'render.js and its test are written; suite green. Over to you.' };
  }
  return { text: 'Agreed, all green. [[done]]' };
}

function start({ port = 0, speed = 1, unref = false } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms * speed));
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'sim-coder' }] }));
    }
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ models: [{ name: 'sim-coder' }] }));
    }
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) { res.statusCode = 404; return res.end('{}'); }

    let body = '';
    for await (const c of req) body += c;
    const { messages } = JSON.parse(body);
    const step = plan(messages, speed);
    if (step.error) {
      res.statusCode = step.error.status;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(step.error.body));
    }

    res.setHeader('content-type', 'text/event-stream');
    const send = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, ...extra }], ...(extra.usage ? { usage: extra.usage } : {}) })}\n\n`);
    const chars = JSON.stringify(messages).length;
    let outTokens = 0;

    if (step.think) {
      for (const w of step.think.split(/(?<= )/)) { send({ reasoning_content: w }); await sleep(25); }
      outTokens += Math.ceil(step.think.length / 4);
    }
    if (step.text) {
      // split mid-tag on purpose to exercise the <think> splitter
      const t = step.text;
      for (let i = 0; i < t.length; i += 7) { send({ content: t.slice(i, i + 7) }); await sleep(8); }
      outTokens += Math.ceil(t.length / 4);
    }
    if (step.tool) {
      const args = JSON.stringify(step.tool.args);
      send({ tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: step.tool.name, arguments: '' } }] });
      for (let i = 0; i < args.length; i += 40) { send({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 40) } }] }); await sleep(5); }
      outTokens += Math.ceil(args.length / 4);
    }
    send({}, { finish_reason: step.tool ? 'tool_calls' : 'stop' });
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: Math.ceil(chars / 4), completion_tokens: outTokens } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      if (unref) server.unref();
      const { port: p } = server.address();
      resolve({ url: `http://127.0.0.1:${p}/v1`, port: p, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
    });
  });
}

let shared = null;
/** One lazily started instance shared by every "local-sim" agent in this process. */
function ensure() {
  if (!shared) shared = start({ speed: 1, unref: true });
  return shared;
}

module.exports = { start, ensure, plan };

if (require.main === module) {
  const i = process.argv.indexOf('--port');
  start({ port: i > 0 ? Number(process.argv[i + 1]) : 11500 }).then((s) => console.log(`fake OpenAI server on ${s.url}`));
}
