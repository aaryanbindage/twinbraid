#!/usr/bin/env node
'use strict';
/**
 * Simulated plain-text coding CLI (stands in for Gemini CLI / Aider in tests).
 * Reads the prompt from stdin (or the last argument), prints progress lines, writes
 * a real file, and finishes with a short message. Mentions of "plan" get a [[done]].
 */
const fs = require('node:fs');
const path = require('node:path');

const speed = Number(process.env.FAKE_CLI_SPEED || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * speed));

(async () => {
  const stdin = process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8');
  const prompt = stdin || process.argv[process.argv.length - 1] || '';
  console.log('Reading the workspace...');
  await sleep(300);
  console.log('Planning changes...');
  await sleep(300);
  const planned = /\bPlan:/.test(prompt);
  if (planned) {
    fs.mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'src', 'render.js'), "module.exports = { render: (s) => '<p>' + s + '</p>' };\nmodule.exports.v = 1;\n");
    console.log('Wrote src/render.js');
    await sleep(200);
    console.log('render.js written. [[done]]');
  } else {
    console.log('Oriented; waiting for the plan. [[silent]]');
  }
})();
