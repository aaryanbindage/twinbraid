'use strict';
const { systemPrompt, ROLES } = require('./protocol');
const { Room } = require('./room');
const { KINDS, createAgent, FALLBACK } = require('./registry');

/**
 * config = {
 *   cwd, lead: 'a' | 'b' | 'none' | <agent id or kind>,
 *   permission: 'workspace'|'careful'|'full', maxExchanges,
 *   agents: [{ kind, model?, baseUrl?, apiKey?, command?, args?, id?, label? }, x2]   any two kinds
 *   demo?: true  -> two scripted agents
 * }
 */
function buildRoom(config) {
  const specs = (config.demo
    ? [{ kind: 'mock', persona: 'lead', id: 'claude', label: 'Claude' }, { kind: 'mock', persona: 'worker', id: 'codex', label: 'Codex' }]
    : config.agents || [{ kind: 'claude' }, { kind: 'codex' }]).map((s) => ({ ...s }));
  if (specs.length !== 2) throw new Error('A room needs exactly two agents');

  // unique ids + labels, even when both agents are the same kind
  const seen = new Map();
  for (const s of specs) {
    const k = KINDS[s.kind];
    if (!k) throw new Error(`Unknown agent kind "${s.kind}"`);
    const baseId = s.id || s.kind.replace(/[^a-z0-9]/gi, '');
    const n = (seen.get(baseId) || 0) + 1;
    seen.set(baseId, n);
    s.id = n > 1 ? `${baseId}${n}` : baseId;
    s.label = s.label || (n > 1 ? `${k.label} ${n}` : k.label);
  }
  if (specs[0].label === specs[1].label) specs[1].label += ' 2';

  // distinct accent colours
  const used = new Set();
  for (const s of specs) {
    let c = s.color || KINDS[s.kind].color;
    if (used.has(c)) c = FALLBACK.find((f) => !used.has(f)) || c;
    used.add(c);
    s.color = c;
  }

  const leadSpec = ['a', 'b'].includes(config.lead)
    ? specs[config.lead === 'a' ? 0 : 1]
    : specs.find((s) => s.id === config.lead || s.kind === config.lead);
  const leadId = config.lead === 'none' ? 'none' : (leadSpec || specs[0]).id;

  const agents = specs.map((s, i) => {
    const peer = specs[1 - i];
    const role = leadId === 'none' ? ROLES.peer(peer.label) : leadId === s.id ? ROLES.lead(peer.label) : ROLES.worker(peer.label);
    const agent = createAgent(s, {
      cwd: config.cwd,
      permission: config.permission || 'workspace',
      system: systemPrompt({ me: s.label, peer: peer.label, role, cwd: config.cwd }),
      speed: config.speed,
      peerName: peer.label,
      persona: s.persona || (leadId === s.id ? 'lead' : 'worker'),
    });
    agent.color = s.color;
    return agent;
  });
  return new Room({ cwd: config.cwd, agents, maxExchanges: config.maxExchanges });
}

module.exports = { buildRoom };
