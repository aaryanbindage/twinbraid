'use strict';
const path = require('node:path');
const { ClaudeAgent } = require('./agents/claude');
const { CodexAgent } = require('./agents/codex');
const { OpenAIAgent } = require('./agents/openai');
const { CliAgent, PRESETS } = require('./agents/cli');
const { MockAgent } = require('./agents/mock');

const SIM_CODEX = path.join(__dirname, '..', 'sim', 'fake-codex.js');

/**
 * Every agent kind Twinbraid can run. `fields` tells the UI which inputs to show.
 * Any two kinds can be paired, including two of the same kind.
 */
const KINDS = {
  claude: { label: 'Claude Code', color: '#da7756', fields: ['model'], hint: 'Claude Code CLI (signed in)' },
  codex: { label: 'Codex', color: '#3fb6a0', fields: ['model'], hint: 'OpenAI Codex CLI (signed in)' },
  ollama: { label: 'Ollama', color: '#e8c15a', fields: ['model', 'baseUrl'], baseUrl: 'http://localhost:11434/v1', local: true, hint: 'Local model; needs a tool-calling model such as qwen2.5-coder' },
  lmstudio: { label: 'LM Studio', color: '#b98cf0', fields: ['model', 'baseUrl'], baseUrl: 'http://localhost:1234/v1', local: true, hint: 'Local server on :1234' },
  llamacpp: { label: 'llama.cpp', color: '#7fb069', fields: ['model', 'baseUrl'], baseUrl: 'http://localhost:8080/v1', local: true, hint: 'llama-server with --jinja for tool calls' },
  openai: { label: 'OpenAI API', color: '#74aa9c', fields: ['model', 'baseUrl', 'apiKey'], baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', hint: 'Uses $OPENAI_API_KEY' },
  openrouter: { label: 'OpenRouter', color: '#6d8cf0', fields: ['model', 'baseUrl', 'apiKey'], baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', hint: 'Uses $OPENROUTER_API_KEY' },
  'openai-compat': { label: 'OpenAI-compatible', color: '#c4a484', fields: ['model', 'baseUrl', 'apiKey'], baseUrl: 'http://localhost:8000/v1', hint: 'vLLM, TGI, LiteLLM, any /v1 server' },
  gemini: { label: 'Gemini CLI', color: '#8ab4f8', fields: ['model'], cli: 'gemini', hint: 'Plain-text CLI mode (no token stats)' },
  aider: { label: 'Aider', color: '#f28b82', fields: ['model'], cli: 'aider', hint: 'Plain-text CLI mode (no token stats)' },
  opencode: { label: 'OpenCode', color: '#a1c4fd', fields: ['model'], cli: 'opencode', hint: 'Plain-text CLI mode (no token stats)' },
  cli: { label: 'Custom CLI', color: '#9aa0a6', fields: ['command', 'args', 'model'], hint: 'Any command that reads a prompt on stdin and prints text' },
  'local-sim': { label: 'Local model (simulated)', color: '#e8c15a', fields: [], sim: true, hint: 'Real local-model agent loop against a fake OpenAI-compatible server' },
  'codex-sim': { label: 'Codex (simulated)', color: '#3fb6a0', fields: [], sim: true, hint: 'Real Codex adapter driven by a fake codex binary' },
  mock: { label: 'Scripted demo', color: '#9aa0a6', fields: [], sim: true, hint: 'No model; scripted behaviour' },
};

const FALLBACK = ['#da7756', '#3fb6a0', '#8ab4f8', '#e8c15a', '#b98cf0'];

function createAgent(spec, ctx) {
  const k = KINDS[spec.kind];
  if (!k) throw new Error(`Unknown agent kind "${spec.kind}"`);
  const base = { ...spec, ...ctx, kind: spec.kind };
  if (spec.kind === 'claude') return new ClaudeAgent(base);
  if (spec.kind === 'codex') return new CodexAgent(base);
  if (spec.kind === 'codex-sim') {
    return new CodexAgent({
      ...base,
      bin: { command: process.execPath, prefix: [SIM_CODEX], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : undefined },
    });
  }
  if (spec.kind === 'mock') return new MockAgent(base);
  if (spec.kind === 'local-sim') {
    const { ensure } = require('../sim/fake-openai-server');
    return new OpenAIAgent({ ...base, model: 'sim-coder', baseUrl: ensure().then((s) => s.url) });
  }
  if (k.baseUrl) {
    return new OpenAIAgent({
      ...base,
      baseUrl: spec.baseUrl || k.baseUrl,
      apiKey: spec.apiKey,
      apiKeyEnv: k.apiKeyEnv,
      contextChars: spec.contextChars,
    });
  }
  if (k.cli) return new CliAgent({ ...base, ...PRESETS[k.cli], command: spec.command || PRESETS[k.cli].command });
  if (spec.kind === 'cli') {
    const args = Array.isArray(spec.args) ? spec.args : String(spec.args || '').match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, '')) || [];
    return new CliAgent({ ...base, command: spec.command, args, promptVia: spec.promptVia || 'stdin', modelFlag: spec.modelFlag });
  }
  throw new Error(`Cannot build agent "${spec.kind}"`);
}

module.exports = { KINDS, createAgent, FALLBACK };
