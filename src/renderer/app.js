'use strict';
(() => {
  const api = window.duet;
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
    return n;
  };

  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    claude: svg('<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/>'),
    codex: svg('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>'),
    other: svg('<circle cx="12" cy="12" r="3"/>'),
    chip: svg('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'),
    star: svg('<path d="M12 3l2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6z"/>'),
    write: svg('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>'),
    shell: svg('<path d="M4 17l6-6-6-6M12 19h8"/>'),
    read: svg('<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
    web: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>'),
    task: svg('<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8z"/>'),
    plan: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
    say: svg('<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>'),
    err: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>'),
    change: svg('<path d="M12 5v14M5 12h14"/>'),
  };

  const TAGS = /\[\[\s*(?:done|wait|silent|ask[-_ ]?user)\s*\]\]/gi;

  const iconFor = (a) => {
    if (a.kind === 'mock') return ICON[a.id] || ICON.other;
    if (ICON[a.kind]) return ICON[a.kind];
    if (a.kind === 'codex-sim') return ICON.codex;
    if (['ollama', 'lmstudio', 'llamacpp', 'local-sim'].includes(a.kind)) return ICON.chip;
    if (['openai', 'openrouter', 'openai-compat', 'gemini'].includes(a.kind)) return ICON.star;
    return ICON.shell;
  };
  const colorOf = (id) => (id === 'user' ? 'var(--you)' : S.panels[id] ? S.panels[id].color : 'var(--faint)');

  // ---- formatting ----------------------------------------------------------
  const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : n.toLocaleString('en-US'));
  const fmtTime = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const p = (x) => String(x).padStart(2, '0');
    return h ? `${h}:${p(m % 60)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
  };
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = (s) => s.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  const md = (t) =>
    t.split('```').map((part, i) => (i % 2
      ? `<pre>${esc(part.replace(/^[\w-]*\n/, '').replace(/\n$/, ''))}</pre>`
      : part.trim().split(/\n{2,}/).filter(Boolean).map((p) => `<p>${inline(esc(p)).replace(/\n/g, '<br>')}</p>`).join(''))).join('');

  // ---- state ---------------------------------------------------------------
  const S = { session: null, panels: {}, order: [], target: 'both', sessionStart: 0, snap: null, room: 'running', busy: false };

  // ============================== SETUP =====================================
  const pick = (segId, val) => {
    const seg = $(segId);
    if (![...seg.querySelectorAll('button')].some((b) => b.dataset.v === val)) return; // stale saved value
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === val));
  };
  const segVal = (segId) => $(`${segId} button.on`).dataset.v;
  const saved = (() => { try { return JSON.parse(localStorage.getItem('duet.setup') || '{}'); } catch { return {}; } })();

  const GROUPS = [
    ['Coding agents', ['claude', 'codex']],
    ['Local models', ['ollama', 'lmstudio', 'llamacpp']],
    ['Cloud APIs', ['openai', 'openrouter', 'openai-compat']],
    ['Other CLIs', ['gemini', 'aider', 'opencode', 'cli']],
    ['Simulators (no login needed)', ['codex-sim', 'local-sim']],
  ];
  const FIELD = {
    model: ['Model', ''],
    baseUrl: ['Server URL', ''],
    apiKey: ['API key (optional, never saved)', 'password'],
    command: ['Command', ''],
    args: ['Arguments', ''],
  };
  const LOCAL_SERVERS = { ollama: 'ollama', lmstudio: 'lmstudio', llamacpp: 'llamacpp' };

  function buildCard(i, sv) {
    const sel = el('select', { class: 'sel' }, ...GROUPS.map(([g, ks]) =>
      el('optgroup', { label: g }, ...ks.filter((k) => S.kinds[k]).map((k) => el('option', { value: k }, S.kinds[k].label)))));
    sel.value = S.kinds[sv.kind] ? sv.kind : (i ? 'codex' : 'claude');
    const inputs = {};
    const rows = Object.entries(FIELD).map(([f, [label, type]]) => {
      const input = el('input', { type: type || 'text', spellcheck: 'false', autocomplete: 'off' });
      if (sv[f] && f !== 'apiKey') input.value = sv[f];
      inputs[f] = input;
      return { f, node: el('label', { class: 'field mini' }, el('span', {}, label), input) };
    });
    const dl = el('datalist', { id: `models${i}` });
    inputs.model.setAttribute('list', `models${i}`);
    const hint = el('div', { class: 'card-hint' });
    const status = el('div', { class: 'card-status' });
    const card = { i, sel, inputs, rows, dl, hint, status };
    const refresh = () => {
      const k = S.kinds[sel.value];
      for (const r of rows) r.node.classList.toggle('hidden', !k.fields.includes(r.f));
      inputs.baseUrl.placeholder = k.baseUrl || '';
      inputs.model.placeholder = LOCAL_SERVERS[sel.value] ? 'pick or type a model' : sel.value === 'claude' ? 'default (e.g. sonnet, opus)' : sel.value === 'codex' ? 'default' : '';
      inputs.command.placeholder = 'e.g. mytool';
      inputs.args.placeholder = 'e.g. --yes --prompt-from-stdin';
      hint.textContent = k.hint || '';
      dl.replaceChildren(...((S.doctor && S.doctor[LOCAL_SERVERS[sel.value]] && S.doctor[LOCAL_SERVERS[sel.value]].models) || []).map((m) => el('option', { value: m })));
      status.replaceChildren(...cardStatus(sel.value));
      updateLeadLabels();
    };
    card.refresh = refresh;
    sel.addEventListener('change', refresh);
    const slotName = i === 0 ? 'Agent A' : 'Agent B';
    card.node = el('div', { class: 'agent-card' }, el('div', { class: 'card-h' }, slotName), sel, ...rows.map((r) => r.node), dl, hint, status);
    return card;
  }

  function cardStatus(kind) {
    const d = S.doctor;
    if (!d) return [];
    const mk = (cls, t) => chip(cls, t);
    if (kind === 'claude') return [d.claude.found ? mk('ok', `installed ${(d.claude.version || '').replace(/\s*\(Claude Code\)/, '')}`) : mk('bad', 'not found: install Claude Code')];
    if (kind === 'codex') {
      if (!d.codex.found) return [mk('bad', 'not found: npm i -g @openai/codex')];
      return [d.codex.loggedIn ? mk('ok', 'signed in') : mk('warn', 'not signed in: run codex login')];
    }
    if (LOCAL_SERVERS[kind]) {
      const s = d[LOCAL_SERVERS[kind]] || {};
      if (!s.up) return [mk('warn', `${S.kinds[kind].label} server not reachable`)];
      return [mk('ok', s.models && s.models.length ? `running · ${s.models.length} model${s.models.length > 1 ? 's' : ''}` : 'running')];
    }
    if (['gemini', 'aider', 'opencode'].includes(kind)) return [d.bins && d.bins[kind] ? mk('ok', 'installed') : mk('bad', `\`${kind}\` not found on PATH`)];
    return [];
  }

  function updateLeadLabels() {
    if (!S.cards) return;
    const [a, b] = S.cards.map((c) => S.kinds[c.sel.value].label);
    const btns = $('#lead').querySelectorAll('button');
    btns[0].textContent = `${a} leads`;
    btns[1].textContent = `${b} leads`;
  }

  function cardValue(c) {
    const v = { kind: c.sel.value };
    for (const f of S.kinds[v.kind].fields) { const x = c.inputs[f].value.trim(); if (x) v[f] = x; }
    return v;
  }

  function initSetup() {
    for (const id of ['#lead', '#perm']) {
      $(id).addEventListener('click', (e) => { if (e.target.dataset.v) pick(id, e.target.dataset.v); });
    }
    if (saved.lead) pick('#lead', saved.lead);
    if (saved.perm) pick('#perm', saved.perm);
    if (saved.cwd) $('#cwd').value = saved.cwd;
    $('#browse').onclick = async () => { const p = await api.invoke('pick-folder'); if (p) $('#cwd').value = p; };
    $('#startBtn').onclick = () => start(false);
    $('#demoBtn').onclick = () => start(true);

    api.invoke('settings').then((s) => {
      const box = $('#recent');
      box.replaceChildren(...(s.recent || []).map((p) => el('button', { title: p, onclick: () => { $('#cwd').value = p; } }, p)));
    });

    api.invoke('kinds').then((kinds) => {
      S.kinds = kinds;
      S.cards = [0, 1].map((i) => buildCard(i, (saved.agents || [])[i] || {}));
      $('#agentsGrid').replaceChildren(...S.cards.map((c) => c.node));
      S.cards.forEach((c) => c.refresh());
      return api.invoke('doctor');
    }).then((d) => {
      S.doctor = d;
      const chips = [];
      chips.push(d.claude.found ? chip('ok', 'Claude Code') : chip('', 'Claude Code: not installed'));
      chips.push(d.codex.found ? (d.codex.loggedIn ? chip('ok', 'Codex') : chip('warn', 'Codex: not signed in')) : chip('', 'Codex: not installed'));
      chips.push(d.ollama.up ? chip('ok', `Ollama · ${d.ollama.models.length} models`) : chip('', 'Ollama: not running'));
      if (d.lmstudio.up) chips.push(chip('ok', 'LM Studio'));
      $('#doctor').replaceChildren(...chips);
      S.cards.forEach((c) => c.refresh());
    });
  }
  const chip = (cls, text) => el('span', { class: `chip ${cls}` }, el('i'), text);

  /** Returns an error string, or null when the pair can start. Also fills sensible defaults. */
  function validate(agents) {
    const d = S.doctor;
    if (!d) return null;
    for (const a of agents) {
      const label = S.kinds[a.kind].label;
      if (a.kind === 'claude' && !d.claude.found) return 'Claude Code CLI not found on PATH.';
      if (a.kind === 'codex' && !d.codex.found) return 'Codex CLI not found. Install it with: npm i -g @openai/codex';
      if (a.kind === 'codex' && !d.codex.loggedIn) return 'Codex is not signed in. Run `codex login` in a terminal, then try again.';
      const srv = LOCAL_SERVERS[a.kind] && d[LOCAL_SERVERS[a.kind]];
      if (srv) {
        if (!srv.up) return `${label} is not running at its default address. Start it, or set the Server URL.`;
        if (!a.model && srv.models && srv.models.length) a.model = srv.models[0];
        if (!a.model && a.kind === 'ollama') return 'Ollama has no models installed. Run: ollama pull qwen2.5-coder';
      }
      if (['llamacpp', 'openai-compat'].includes(a.kind) && !a.model) a.model = 'default';
      if (['openai', 'openrouter'].includes(a.kind) && !a.model) return `${label}: enter a model name.`;
      if (['gemini', 'aider', 'opencode'].includes(a.kind) && !(d.bins && d.bins[a.kind])) return `\`${a.kind}\` not found on PATH.`;
      if (a.kind === 'cli' && !a.command) return 'Custom CLI: enter the command to run.';
    }
    return null;
  }

  async function start(demo) {
    $('#setupErr').textContent = '';
    const agents = S.cards.map(cardValue);
    const cfg = {
      demo,
      cwd: $('#cwd').value.trim(),
      task: $('#task').value,
      lead: segVal('#lead'),
      permission: segVal('#perm'),
      maxExchanges: Number($('#maxEx').value) || 14,
      agents,
    };
    if (demo) { cfg.cwd = ''; cfg.task = cfg.task.trim() || 'Build a small markdown-to-HTML converter with tests.'; cfg.lead = 'a'; }
    else {
      const err = validate(agents);
      if (err) return fail(err);
    }
    // API keys are passed through for this run only and never written to disk
    const keys = S.cards.map((c) => (c.inputs.apiKey.value || '').trim());
    agents.forEach((a, i) => { if (keys[i]) a.apiKey = keys[i]; });
    try {
      const keep = S.cards.map(cardValue);
      localStorage.setItem('duet.setup', JSON.stringify({ cwd: cfg.cwd, lead: cfg.lead, perm: cfg.permission, agents: keep }));
    } catch { /* ignore */ }
    const r = await api.invoke('start', cfg);
    if (!r.ok) fail(r.error);
  }
  const fail = (m) => { $('#setupErr').textContent = m; };

  // ============================== STAGE =====================================
  function resetStage() {
    for (const p of Object.values(S.panels)) clearInterval(p.timer);
    S.panels = {}; S.order = []; S.session = null; S.snap = null; S.room = 'running';
    $('#paneL').replaceChildren(); $('#paneR').replaceChildren(); $('#chat').replaceChildren();
    $('#banner').textContent = '';
  }

  function buildStage(session) {
    resetStage();
    S.session = session;
    S.sessionStart = session.ts;
    S.order = session.agents.map((a) => a.id);
    session.agents.forEach((a, i) => {
      const p = buildPanel(a, i);
      S.panels[a.id] = p;
      $(i === 0 ? '#paneL' : '#paneR').replaceChildren(...p.nodes);
    });
    $('#setup').classList.add('hidden');
    $('#stage').classList.remove('hidden');
    $('#totals').classList.remove('hidden');
    $('#sessionTitle').textContent = `${session.cwd}  ·  ${session.task.slice(0, 90)}`;
    $('#sessionTitle').title = session.task;

    const seg = $('#target');
    seg.replaceChildren(
      el('button', { type: 'button', 'data-v': 'both', style: '--c:var(--you)', class: 'on' }, 'Both'),
      ...session.agents.map((a) => el('button', { type: 'button', 'data-v': a.id, style: `--c:${a.color}` }, a.label)));
    S.target = 'both';
    seg.onclick = (e) => { if (e.target.dataset.v) setTarget(e.target.dataset.v); };

    $('#topActions').replaceChildren(
      el('button', { class: 'btn sm', onclick: () => api.invoke('open-folder', session.cwd) }, 'Open folder'),
      el('button', { class: 'btn sm danger', onclick: () => api.invoke('stop-all') }, '■ Stop all'),
      el('button', { class: 'btn sm', onclick: newSession }, 'New session'));
    chatEmpty();
  }

  function chatEmpty() {
    $('#chat').replaceChildren(el('div', { class: 'empty-chat' }, 'Agent-to-agent messages will appear here as they plan, hand off and review each other.'));
  }

  function setTarget(v) {
    S.target = v;
    $('#target').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    updateHint();
    $('#msg').focus();
  }

  function newSession() {
    api.invoke('reset');
    resetStage();
    $('#stage').classList.add('hidden');
    $('#setup').classList.remove('hidden');
    $('#totals').classList.add('hidden');
    $('#topActions').replaceChildren();
    $('#sessionTitle').textContent = '';
  }

  function buildPanel(a, slot) {
    const P = { id: a.id, label: a.label, color: a.color || 'var(--faint)', slot, rows: new Map(), thinkNode: document.createTextNode(''), turnStart: 0, gotThinkText: false, thinkTokens: 0, dirty: false };
    const stat = (k) => {
      const v = el('div', { class: 'v' }, '0');
      const s = el('div', { class: 's' }, ' ');
      return { box: el('div', { class: 'stat' }, el('div', { class: 'k' }, k), v, s), v, s };
    };
    P.st = { tok: stat('Tokens'), lines: stat('Lines'), cost: stat('Cost'), files: stat('Files'), tools: stat('Tool calls'), turns: stat('Turns') };

    P.state = el('div', { class: 'pstate' }, 'Idle');
    P.nowText = el('div', { class: 'now-text' }, 'Waiting to start');
    P.timer = null;
    P.turnTimer = el('span');
    P.think = el('div', { class: 'think' }, el('span', { class: 'empty' }, 'Reasoning will stream here.'));
    P.thinkBadge = el('span', { class: 'badge' });
    P.feed = el('div', { class: 'feed' });
    P.queued = el('span', { class: 'queued' });
    P.btnInt = el('button', { class: 'btn sm danger', onclick: () => api.invoke('interrupt', a.id) }, '■ Interrupt');
    P.btnRes = el('button', { class: 'btn sm', onclick: () => api.invoke('resume', a.id) }, '▶ Resume');
    P.btnRes.classList.add('hidden');
    P.btnMsg = el('button', { class: 'btn sm', onclick: () => setTarget(a.id) }, `Message ${a.label}`);

    const header = el('div', { class: 'ph' },
      el('div', { class: 'avatar', html: iconFor(a) }),
      el('div', {}, el('div', { class: 'pname' }, a.label), P.modelEl = el('div', { class: 'pmodel' }, a.model || a.kind)),
      P.state);
    P.nodes = [
      header,
      el('div', { class: 'now' }, el('div', { class: 'now-label' }, el('span', {}, 'Now'), P.turnTimer), P.nowText),
      el('div', { class: 'stats' }, ...Object.values(P.st).map((x) => x.box)),
      el('div', { class: 'sec think-wrap' }, el('div', { class: 'sec-h' }, 'Thinking', P.thinkBadge), P.think),
      el('div', { class: 'sec feed-wrap' }, el('div', { class: 'sec-h' }, 'Activity'), P.feed),
      el('div', { class: 'pfoot' }, P.btnInt, P.btnRes, P.queued, el('span', { class: 'grow' }), P.btnMsg),
    ];
    return P;
  }

  const paneOf = (P) => $(P.slot === 0 ? '#paneL' : '#paneR');
  function setPane(P, attrs) {
    const pane = paneOf(P);
    pane.style.setProperty('--c', P.color);
    for (const [k, v] of Object.entries(attrs)) pane.dataset[k] = v;
  }

  // ---- event handling ------------------------------------------------------
  const ACTIVE = new Set(['thinking', 'editing', 'working', 'writing']);
  const dirty = new Set();

  function handle(ev) {
    if (ev.t === 'session') { buildStage(ev); setPane0(); return; }
    if (!S.session) return;
    const P = ev.agent ? S.panels[ev.agent] : null;
    switch (ev.t) {
      case 'chat': addChat(ev); break;
      case 'room': onRoom(ev); break;
      case 'attention': break;
      case 'stats': onStats(ev); break;
      case 'meta': if (P && ev.model) P.modelEl.textContent = ev.model; break;
      case 'status': if (P) onStatus(P, ev); break;
      case 'turn': if (P) onTurn(P, ev); break;
      case 'thinking': if (P) onThinking(P, ev); break;
      case 'thinking_tokens': if (P) { P.thinkTokens = ev.tokens; P.thinkBadge.textContent = `~${fmtNum(ev.tokens)} thinking tokens`; } break;
      case 'text': if (P) onText(P, ev); break;
      case 'tool': if (P) onTool(P, ev); break;
      case 'change': if (P) onChange(P, ev); break;
      case 'inbox': if (P) onInbox(P, ev); break;
      case 'error': if (P) addRow(P, 'err', ev.text.split('\n')[0], 'bad'); break;
      case 'log': if (P) addRow(P, 'err', ev.text, 'bad'); break;
      default:
    }
  }
  const setPane0 = () => { for (const P of Object.values(S.panels)) setPane(P, { id: P.id, slot: P.slot, state: 'idle', active: '0', done: '0' }); };

  function onStatus(P, ev) {
    const active = ACTIVE.has(ev.state);
    setPane(P, { state: ev.state, active: active ? '1' : '0' });
    P.stateName = ev.state;
    P.nowText.textContent = ev.label;
    P.state.textContent = { thinking: 'Thinking', editing: 'Editing', working: 'Working', writing: 'Writing', idle: 'Idle', held: 'Held', error: 'Error' }[ev.state] || ev.state;
    P.think.classList.toggle('live', ev.state === 'thinking');
    P.btnInt.classList.toggle('hidden', !active);
    P.btnRes.classList.toggle('hidden', ev.state !== 'held');
    updateHint();
  }

  function onTurn(P, ev) {
    if (ev.phase === 'start') {
      P.turnN = ev.n;
      P.turnStart = ev.ts;
      P.gotThinkText = false;
      clearInterval(P.timer);
      P.timer = setInterval(() => { P.turnTimer.textContent = fmtTime(Date.now() - P.turnStart); }, 1000);
      if (P.think.querySelector('.empty')) P.think.replaceChildren();
      P.think.append(el('span', { class: 'turn-sep' }, `— turn ${ev.n} —`));
      P.thinkNode = document.createTextNode('');
      P.think.append(P.thinkNode);
    } else {
      clearInterval(P.timer);
      P.turnTimer.textContent = '';
      if (!P.gotThinkText && P.thinkTokens) {
        P.think.append(el('span', { class: 'est' }, `(reasoning summary not exposed; used ~${fmtNum(P.thinkTokens)} thinking tokens)\n`));
        P.thinkNode = document.createTextNode('');
        P.think.append(P.thinkNode);
      }
      P.thinkTokens = 0;
      P.thinkBadge.textContent = '';
    }
  }

  function onThinking(P, ev) {
    P.gotThinkText = true;
    P.thinkNode.data += ev.text;
    if (P.thinkNode.data.length > 9000) P.thinkNode.data = '…' + P.thinkNode.data.slice(-7000);
    dirty.add(P.think);
  }

  function addRow(P, kind, text, st, key) {
    let row = key && P.rows.get(key);
    if (!row) {
      row = el('div', { class: 'row-t', 'data-kind': kind, 'data-st': st || '' },
        el('span', { class: 'ic', html: ICON[kind] || ICON.other }), el('span', { class: 'tx' }), el('span', { class: 'diff' }), el('span', { class: 'st' }));
      P.feed.prepend(row);
      if (key) P.rows.set(key, row);
      while (P.feed.children.length > 70) { const last = P.feed.lastChild; for (const [k, v] of P.rows) if (v === last) P.rows.delete(k); last.remove(); }
    }
    row.dataset.st = st || '';
    row.children[1].textContent = text;
    row.children[1].title = text;
    return row;
  }

  function onText(P, ev) {
    const key = `say:${P.turnN}:${ev.block}`;
    const prev = P.rows.get(key);
    // keep the raw stream (chunk edges carry meaningful spaces); tidy only what is displayed
    const raw = ((prev && prev.dataset.raw) || '') + ev.text;
    const row = addRow(P, 'say', raw.replace(TAGS, '').replace(/\s+/g, ' ').trim().slice(0, 220), '', key);
    row.dataset.raw = raw.slice(0, 800);
  }

  function onTool(P, ev) {
    const text = ev.summary || ev.name;
    const row = addRow(P, ev.kind === 'plan' ? 'plan' : ev.kind || 'other', text, ev.phase === 'end' ? (ev.ok ? 'ok' : 'bad') : 'run', `tool:${ev.id}`);
    row.dataset.kind = ev.kind || 'other';
    if (ev.file) row.dataset.file = ev.rel || ev.file;
    if (ev.hint && ev.phase !== 'end') row.children[2].innerHTML = `<span class="add">+${ev.hint.add}</span> <span class="del">−${ev.hint.del}</span>`;
  }

  function onChange(P, ev) {
    for (const f of ev.files) {
      const rows = [...P.feed.querySelectorAll('.row-t[data-kind="write"]')].filter((r) => r.dataset.file === f.file);
      const row = rows[0];
      const html = `<span class="add">+${f.add}</span> <span class="del">−${f.del}</span>`;
      if (row) row.children[2].innerHTML = html;
      else addRow(P, 'change', `${f.file}${f.created ? ' (new)' : ''}`, 'ok').children[2].innerHTML = html;
    }
  }

  function onInbox(P, ev) {
    P.queued.textContent = ev.count ? `${ev.count} queued` : '';
    updateHint();
  }

  function onStats(ev) {
    S.snap = ev;
    let tok = 0; let add = 0; let del = 0; let cost = 0;
    for (const [id, s] of Object.entries(ev.agents)) {
      const P = S.panels[id];
      if (!P) continue;
      tok += s.tokens; add += s.add; del += s.del; cost += s.cost;
      P.st.tok.v.textContent = fmtNum(s.tokens);
      P.st.tok.s.textContent = `in ${fmtNum(s.in)} · out ${fmtNum(s.out)}${s.cached ? ` · cache ${fmtNum(s.cached)}` : ''}`;
      P.st.lines.v.innerHTML = `<span class="add">+${fmtNum(s.add)}</span> <span class="del">−${fmtNum(s.del)}</span>`;
      P.st.lines.s.textContent = 'written this session';
      P.st.cost.v.textContent = s.cost ? `$${s.cost.toFixed(s.cost < 1 ? 3 : 2)}` : '—';
      P.st.cost.s.textContent = s.cost ? 'API-equivalent' : 'subscription / n/a';
      P.st.files.v.textContent = s.files;
      P.st.files.s.textContent = 'files touched';
      P.st.tools.v.textContent = s.tools;
      P.st.tools.s.textContent = s.reasoning ? `${fmtNum(s.reasoning)} reasoning tok` : ' ';
      P.st.turns.v.textContent = s.turns;
      P.st.turns.s.textContent = `${fmtTime(s.activeMs)} active`;
      setPane(P, { done: s.done ? '1' : '0' });
      if (s.done && !ACTIVE.has(P.stateName)) P.state.textContent = 'Done';
    }
    S.totals = { tok, add, del, cost };
    renderTotals();
  }

  function renderTotals() {
    const t = S.totals || { tok: 0, add: 0, del: 0, cost: 0 };
    $('#totals').innerHTML =
      `<span><b>${fmtNum(t.tok)}</b> tokens</span>` +
      `<span><b class="add">+${fmtNum(t.add)}</b> <b class="del">−${fmtNum(t.del)}</b></span>` +
      (t.cost ? `<span><b>$${t.cost.toFixed(t.cost < 1 ? 3 : 2)}</b></span>` : '') +
      `<span><b>${fmtTime(Date.now() - S.sessionStart)}</b></span>`;
  }
  setInterval(() => { if (S.session) renderTotals(); }, 1000);

  const BANNER = {
    running: ['run', 'Working — agents are collaborating'],
    'idle:done': ['done', 'Done — both agents agree the task is complete'],
    'idle:quiet': ['idle', 'Idle — both agents are waiting. Send a message to continue.'],
    'idle:ask-user': ['ask', 'An agent is waiting for your decision'],
    'idle:limit': ['limit', 'Paused to save tokens — they reached the message limit without you'],
    'idle:paused': ['idle', 'Paused — resume an agent or send a message'],
  };
  function onRoom(ev) {
    const [s, text] = BANNER[ev.state === 'running' ? 'running' : `idle:${ev.reason}`] || ['idle', 'Idle'];
    const b = $('#banner');
    b.dataset.s = s;
    b.replaceChildren(el('i'), text);
  }

  // ---- chat ----------------------------------------------------------------
  const nameOf = (id) => (id === 'user' ? 'You' : id === 'both' ? 'Both' : S.panels[id] ? S.panels[id].label : id);
  function addChat(ev) {
    const chat = $('#chat');
    const stick = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
    if (chat.querySelector('.empty-chat')) chat.replaceChildren();
    let node;
    if (['system', 'interrupt', 'error', 'conflict'].includes(ev.kind) || ev.from === 'system') {
      node = el('div', { class: `sys ${ev.kind}` }, ev.text);
    } else if (ev.kind === 'note') {
      node = el('div', { class: 'note' }, `${nameOf(ev.from)}: ${ev.text}`);
    } else {
      const tags = [];
      if (ev.kind === 'task') tags.push(el('span', { class: 'tag' }, 'task'));
      if (ev.kind === 'ask') tags.push(el('span', { class: 'tag warn' }, 'needs you'));
      if (ev.kind === 'done') tags.push(el('span', { class: 'tag ok' }, 'done'));
      if (ev.interrupt) tags.push(el('span', { class: 'tag warn' }, '⚡ interrupt'));
      node = el('div', { class: 'msg', 'data-from': ev.from === 'user' ? 'user' : 'agent', 'data-kind': ev.kind || '', style: `--wc:${colorOf(ev.from)}` },
        el('div', { class: 'meta' }, el('span', { class: 'who' }, nameOf(ev.from)), el('span', { class: 'arrow' }, '→'), el('span', { class: 'who', style: `--wc:${ev.to === 'both' ? 'var(--faint)' : colorOf(ev.to)}` }, nameOf(ev.to)), ...tags, el('span', { class: 'time' }, clock(ev.ts))),
        el('div', { class: 'bubble', html: md(ev.text) }));
    }
    chat.append(node);
    if (stick || ev.from === 'user') chat.scrollTop = chat.scrollHeight;
  }

  // ---- composer ------------------------------------------------------------
  function updateHint() {
    const hint = $('#composeHint');
    if (!S.session) return;
    const ids = S.target === 'both' ? S.order : [S.target];
    const busy = ids.filter((id) => S.panels[id] && ACTIVE.has(S.panels[id].stateName));
    const names = busy.map((id) => S.panels[id].label).join(' & ');
    hint.textContent = busy.length && !$('#interrupt').checked
      ? `${names} ${busy.length > 1 ? 'are' : 'is'} mid-task: this is delivered at the end of the current turn. Tick ⚡ to cut in now.`
      : S.target === 'both' ? 'Broadcast: both agents get this' : '';
  }
  $('#interrupt').addEventListener('change', updateHint);

  function sendMsg() {
    const box = $('#msg');
    const text = box.value.trim();
    if (!text || !S.session) return;
    api.invoke('send', { to: S.target, text, interrupt: $('#interrupt').checked });
    box.value = '';
    $('#interrupt').checked = false;
    updateHint();
  }
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendMsg(); });
  $('#msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });

  // ---- bootstrap -----------------------------------------------------------
  api.onEvents((batch) => {
    for (const ev of batch) handle(ev);
    for (const n of dirty) n.scrollTop = n.scrollHeight;
    dirty.clear();
  });
  api.onAutoDemo(async (opts) => {
    if (!opts.sim) return start(true);
    // dev: a mixed pair of simulated agents running through the real Codex and local-model adapters
    const r = await api.invoke('start', {
      cwd: '', task: 'Build a small markdown-to-HTML converter with tests.', lead: 'a', permission: 'workspace', maxExchanges: 14,
      agents: [{ kind: 'codex-sim' }, { kind: 'local-sim' }],
    });
    if (!r.ok) fail(r.error);
  });
  document.body.dataset.platform = api.platform;
  initSetup();
  api.invoke('history').then((h) => { if (h && h.length) { h.forEach(handle); for (const P of Object.values(S.panels)) P.think.scrollTop = P.think.scrollHeight; } });
})();

