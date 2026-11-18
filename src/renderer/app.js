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
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === val));
  };
  const segVal = (segId) => $(`${segId} button.on`).dataset.v;
  const saved = (() => { try { return JSON.parse(localStorage.getItem('duet.setup') || '{}'); } catch { return {}; } })();

  function initSetup() {
    for (const id of ['#lead', '#perm']) {
      $(id).addEventListener('click', (e) => { if (e.target.dataset.v) pick(id, e.target.dataset.v); });
    }
    if (saved.lead) pick('#lead', saved.lead);
    if (saved.perm) pick('#perm', saved.perm);
    if (saved.cwd) $('#cwd').value = saved.cwd;
    $('#mClaude').value = saved.mClaude || '';
    $('#mCodex').value = saved.mCodex || '';
    $('#browse').onclick = async () => { const p = await api.invoke('pick-folder'); if (p) $('#cwd').value = p; };
    $('#startBtn').onclick = () => start(false);
    $('#demoBtn').onclick = () => start(true);

    api.invoke('settings').then((s) => {
      const box = $('#recent');
      box.replaceChildren(...(s.recent || []).map((p) => el('button', { title: p, onclick: () => { $('#cwd').value = p; } }, p)));
    });
    api.invoke('doctor').then((d) => {
      const chips = [];
      chips.push(d.claude.found ? chip('ok', `Claude Code ${(d.claude.version || '').replace(/\s*\(Claude Code\)/, '')}`) : chip('bad', 'Claude Code not found'));
      if (!d.codex.found) chips.push(chip('bad', 'Codex CLI not found'));
      else chips.push(d.codex.loggedIn ? chip('ok', `Codex ${d.codex.version || ''}`) : chip('warn', 'Codex not signed in — run: codex login'));
      S.doctor = d;
      $('#doctor').replaceChildren(...chips);
    });
  }
  const chip = (cls, text) => el('span', { class: `chip ${cls}` }, el('i'), text);

  async function start(demo) {
    $('#setupErr').textContent = '';
    const cfg = {
      demo,
      cwd: $('#cwd').value.trim(),
      task: $('#task').value,
      lead: segVal('#lead'),
      permission: segVal('#perm'),
      maxExchanges: Number($('#maxEx').value) || 14,
      agents: [
        { id: 'claude', kind: 'claude', model: $('#mClaude').value.trim() },
        { id: 'codex', kind: 'codex', model: $('#mCodex').value.trim() },
      ],
    };
    if (demo) { cfg.cwd = ''; cfg.task = cfg.task.trim() || 'Build a small markdown-to-HTML converter with tests.'; cfg.lead = 'claude'; }
    else {
      const d = S.doctor;
      if (d && !d.claude.found) return fail('Claude Code CLI not found on PATH.');
      if (d && !d.codex.found) return fail('Codex CLI not found. Install it with: npm i -g @openai/codex');
      if (d && !d.codex.loggedIn) return fail('Codex is not signed in. Run `codex login` in a terminal, then try again.');
    }
    try { localStorage.setItem('duet.setup', JSON.stringify({ cwd: cfg.cwd, lead: cfg.lead, perm: cfg.permission, mClaude: cfg.agents[0].model, mCodex: cfg.agents[1].model })); } catch { /* ignore */ }
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
      el('button', { type: 'button', 'data-v': 'both', 'data-c': 'both', class: 'on' }, 'Both'),
      ...session.agents.map((a) => el('button', { type: 'button', 'data-v': a.id, 'data-c': a.id }, a.label)));
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
    const P = { id: a.id, label: a.label, slot, rows: new Map(), thinkNode: document.createTextNode(''), turnStart: 0, gotThinkText: false, thinkTokens: 0, dirty: false };
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
      el('div', { class: 'avatar', html: ICON[a.kind === 'mock' ? a.id : a.kind] || ICON.other }),
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
  function setPane(P, attrs) { const pane = paneOf(P); for (const [k, v] of Object.entries(attrs)) pane.dataset[k] = v; }

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
    const text = (((prev && prev.dataset.full) || '') + ev.text).replace(TAGS, '').trim();
    const row = addRow(P, 'say', text.replace(/\s+/g, ' ').slice(0, 220), '', key);
    row.dataset.full = text.slice(0, 600);
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
      node = el('div', { class: 'msg', 'data-from': ev.from, 'data-kind': ev.kind || '' },
        el('div', { class: 'meta' }, el('span', { class: 'who' }, nameOf(ev.from)), el('span', { class: 'arrow' }, '→'), el('span', { class: 'who', style: `--wc:var(--${ev.to === 'user' ? 'you' : ev.to === 'claude' || ev.to === 'codex' ? ev.to : 'faint'})` }, nameOf(ev.to)), ...tags, el('span', { class: 'time' }, clock(ev.ts))),
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
  api.onAutoDemo(() => start(true));
  initSetup();
  api.invoke('history').then((h) => { if (h && h.length) { h.forEach(handle); for (const P of Object.values(S.panels)) P.think.scrollTop = P.think.scrollHeight; } });
})();

