'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Agent } = require('./base');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lines(n, make) {
  return Array.from({ length: n }, (_, i) => make(i)).join('\n') + '\n';
}

const PARSER = `'use strict';
// Tiny markdown -> token parser
${lines(70, (i) => `function rule${i}(line) { return line.startsWith('${'#'.repeat((i % 6) + 1)} ') ? { level: ${(i % 6) + 1}, text: line.slice(${(i % 6) + 2}) } : null; }`)}
module.exports = { parse(src) { return src.split('\\n').map((l) => rule0(l) || { text: l }); } };
`;

const RENDER = `'use strict';
const { parse } = require('./parser');
${lines(40, (i) => `const tag${i} = (t) => '<h${(i % 6) + 1}>' + t + '</h${(i % 6) + 1}>';`)}
module.exports = { render: (src) => parse(src).map((t) => (t.level ? tag0(t.text) : '<p>' + t.text + '</p>')).join('') };
`;

/**
 * Scripted stand-in for a real agent. It writes real files and emits the same
 * events a CLI adapter would, so the Room, UI and tests run without logins.
 */
class MockAgent extends Agent {
  constructor(opts) {
    super({ ...opts, kind: opts.kind || 'mock' });
    this.persona = opts.persona || 'lead';
    this.speed = opts.speed ?? 1;
    this.peerName = opts.peerName || 'peer';
    this.turnNo = 0;
    this._abort = false;
  }

  interrupt() {
    if (!this.running) return false;
    this._interrupted = true;
    this._abort = true;
    return true;
  }

  async wait(ms) {
    const end = Date.now() + ms * this.speed;
    while (Date.now() < end) {
      if (this._abort) throw new Error('aborted');
      await sleep(Math.min(25, Math.max(1, end - Date.now())));
    }
    if (this._abort) throw new Error('aborted');
  }

  async think(text, tokens = 120) {
    this.emitEv({ t: 'status', state: 'thinking', label: 'Thinking…' });
    for (const word of text.split(/(\s+)/)) {
      this.emitEv({ t: 'thinking', text: word, block: 'th' });
      await this.wait(14);
    }
    this.emitEv({ t: 'thinking', text: '\n', block: 'th' });
    this.turnUsage.out += tokens;
    this.turnUsage.reasoning += tokens;
    this.emitEv({ t: 'usage' });
  }

  async tool(name, input, effect, ms = 500) {
    const id = `${this.id}-${++this._toolSeq}`;
    this.toolStart(id, name, input);
    await this.wait(ms);
    if (effect) effect();
    this.toolEnd(id, true);
    this.turnUsage.in += 900 + Math.floor(Math.random() * 600);
    this.turnUsage.out += 80;
    this.turnUsage.cost += 0.0021;
    this.emitEv({ t: 'usage' });
  }

  write(rel, content) {
    return () => {
      const abs = path.resolve(this.cwd, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    };
  }

  async runTurn(prompt) {
    if (this.running) throw new Error(`${this.id} is already running a turn`);
    this.running = true;
    this._interrupted = false;
    this._abort = false;
    this._final = '';
    this._toolSeq = this._toolSeq || 0;
    this.turnUsage = { in: 0, out: 0, cached: 0, reasoning: 0, cost: 0 };
    this.turns++;
    this.turnNo++;
    this.emitEv({ t: 'turn', phase: 'start', n: this.turns });
    this.emitEv({ t: 'meta', model: this.model || 'mock-1', session: `mock-${this.id}` });
    try {
      await this.script(prompt);
      return this._finish({ ok: true });
    } catch (err) {
      if (this._interrupted) return this._finish({ ok: false, interrupted: true });
      return this._finish({ ok: false, error: err.message });
    }
  }

  async script(prompt) {
    const me = this.id;
    const peer = this.peerName;
    // turn 1 carries the kickoff task; only later user messages are redirects
    const fromUser = this.turnNo > 1 && /\[from user\]/i.test(prompt);
    const userText = (/\[from user\]\s*([^\n]*)/i.exec(prompt) || [])[1];

    if (fromUser) {
      await this.think(`The supervisor just said: "${userText}". That changes my priorities, so I will adapt my current plan before touching anything else.`);
      this.emitEv({ t: 'text', text: `Understood: ${userText}`, block: 'x' });
      this.setFinal(`Supervisor said "${userText}". I am adjusting. ${peer}, please keep that in mind for your part.`);
      return;
    }

    if (this.persona === 'lead') {
      if (this.turnNo === 1) {
        await this.think('Task: build a markdown to HTML converter. I will split this: I take the parser (src/parser.js); the peer takes the renderer and tests. Let me look at the repo first to avoid clobbering anything.', 220);
        await this.tool('Glob', { pattern: '**/*' }, null, 350);
        await this.tool('Read', { file_path: 'package.json' }, null, 300);
        await this.think('Repo is empty apart from package.json. Writing the parser now, a big chunk. Interface: parse(src) -> tokens with {level,text}.', 160);
        await this.tool('Write', { file_path: path.join(this.cwd, 'src/parser.js') }, this.write('src/parser.js', PARSER), 900);
        this.setFinal(`Plan: I own src/parser.js (done, exports parse(src) -> [{level?,text}]). ${peer}: please build src/render.js using parse() plus a test in test/render.test.js, and run them. Ping me when green.`);
      } else {
        await this.think('The peer says render + tests exist. Reviewing for interface mismatches and running the suite.', 140);
        await this.tool('Read', { file_path: path.join(this.cwd, 'src/render.js') }, null, 400);
        await this.tool('Bash', { command: 'node --test test/' }, null, 900);
        await this.tool('Edit', { file_path: path.join(this.cwd, 'src/parser.js') }, () => fs.appendFileSync(path.resolve(this.cwd, 'src/parser.js'), '// reviewed: heading levels verified\n'), 500);
        this.setFinal(`Reviewed render.js and ran the suite: green. Heading levels verified. [[done]] Markdown converter complete.`);
      }
    } else {
      if (this.turnNo === 1) {
        await this.think('I am the implementer. First turn is read-only orientation: skim the repo, do not edit, then wait for the lead\'s plan.', 90);
        await this.tool('Glob', { pattern: '**/*' }, null, 400);
        this.setFinal('Oriented, nothing to flag. [[wait]]');
      } else if (this.turnNo === 2) {
        await this.think('The lead owns the parser and wants render.js plus tests. I must not touch src/parser.js. Starting with the renderer.', 200);
        await this.tool('Write', { file_path: path.join(this.cwd, 'src/render.js') }, this.write('src/render.js', RENDER), 1100);
        await this.tool('Write', { file_path: path.join(this.cwd, 'test/render.test.js') }, this.write('test/render.test.js',
          `const test = require('node:test');\nconst assert = require('node:assert');\nconst { render } = require('../src/render');\ntest('heading', () => assert.match(render('# hi'), /<h1>hi<\\/h1>/));\n`), 600);
        await this.tool('Bash', { command: 'node --test test/' }, null, 800);
        this.setFinal(`${peer}: renderer + test written (src/render.js, test/render.test.js), suite is green. Over to you for review.`);
      } else {
        await this.think('Lead approved. Nothing left on my side.', 40);
        this.setFinal('Agreed, all green. [[done]]');
      }
    }
    this.emitEv({ t: 'text', text: this._final, block: 'f' });
  }
}

module.exports = { MockAgent };
