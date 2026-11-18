'use strict';
const { ClaudeAgent } = require('./agents/claude');
const { CodexAgent } = require('./agents/codex');
const { MockAgent } = require('./agents/mock');
const { systemPrompt, ROLES } = require('./protocol');
const { Room } = require('./room');

const LABELS = { claude: 'Claude', codex: 'Codex', mock: 'Mock' };

/**
 * config = {
 *   cwd, task, lead: 'claude'|'codex'|'none',
 *   permission: 'workspace'|'careful'|'full',
 *   maxExchanges,
 *   agents: [{ id, kind, model?, binPath? }, ...]   (exactly two)
 *   demo?: true  -> two scripted mock agents
 * }
 */
function buildRoom(config) {
  const specs = config.demo
    ? [{ id: 'claude', kind: 'mock', persona: 'lead', label: 'Claude' }, { id: 'codex', kind: 'mock', persona: 'worker', label: 'Codex' }]
    : config.agents || [{ id: 'claude', kind: 'claude' }, { id: 'codex', kind: 'codex' }];
  if (specs.length !== 2) throw new Error('A room needs exactly two agents');
  const lead = config.lead || specs[0].id;

  const agents = specs.map((s, i) => {
    const peerSpec = specs[1 - i];
    const peerLabel = peerSpec.label || LABELS[peerSpec.kind] || peerSpec.id;
    const role = lead === 'none' ? ROLES.peer(peerLabel) : lead === s.id ? ROLES.lead(peerLabel) : ROLES.worker(peerLabel);
    const label = s.label || LABELS[s.kind] || s.id;
    const base = {
      ...s,
      label,
      cwd: config.cwd,
      permission: config.permission || 'workspace',
      system: systemPrompt({ me: label, peer: peerLabel, role, cwd: config.cwd }),
      speed: config.speed,
      peerName: peerLabel,
      persona: s.persona || (lead === s.id ? 'lead' : 'worker'),
    };
    if (s.kind === 'claude') return new ClaudeAgent(base);
    if (s.kind === 'codex') return new CodexAgent(base);
    return new MockAgent(base);
  });
  return new Room({ cwd: config.cwd, agents, maxExchanges: config.maxExchanges });
}

module.exports = { buildRoom };
