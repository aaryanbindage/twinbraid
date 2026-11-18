'use strict';
const { app, BrowserWindow, ipcMain, dialog, Notification, shell } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildRoom } = require('../core/factory');
const { resolveClaude, resolveCodex, childEnv } = require('../core/proc');

const DATA = path.join(os.homedir(), '.duet');
const SETTINGS = path.join(DATA, 'settings.json');
const DEMO_FLAG = process.argv.includes('--demo');

let win = null;
let room = null;
let logStream = null;
let batch = [];
let flushTimer = null;

if (!app.requestSingleInstanceLock()) app.quit();

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return { recent: [] }; }
}
function writeSettings(s) {
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2)); } catch { /* non-fatal */ }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: '#1a1917',
    title: 'Duet',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1a1917', symbolColor: '#d9d3c7', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

// ---- event plumbing -------------------------------------------------------
function flush() {
  flushTimer = null;
  if (!batch.length || !win) { batch = []; return; }
  win.webContents.send('events', batch);
  batch = [];
}

function attach(r) {
  fs.mkdirSync(path.join(DATA, 'sessions'), { recursive: true });
  const file = path.join(DATA, 'sessions', `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  logStream = fs.createWriteStream(file, { flags: 'a' });
  r.on('event', (ev) => {
    // deltas are noisy and recoverable from the final transcript; skip them on disk
    if (logStream && ev.t !== 'thinking' && ev.t !== 'text' && ev.t !== 'stats') logStream.write(JSON.stringify(ev) + '\n');
    batch.push(ev);
    if (!flushTimer) flushTimer = setTimeout(flush, 40);
    if (ev.t === 'attention' || (ev.t === 'room' && ev.state === 'idle' && ev.reason === 'done')) notify(ev);
  });
}

function notify(ev) {
  if (!win || win.isFocused() || !Notification.isSupported()) return;
  const n = new Notification({
    title: ev.t === 'attention' ? `${ev.agent} needs you` : 'Duet: task complete',
    body: ev.t === 'attention' ? (ev.text || '').slice(0, 160) : 'Both agents agree the work is done.',
  });
  n.on('click', () => { if (win) { win.show(); win.focus(); } });
  n.show();
}

function teardown() {
  if (room) { room.dispose(); room = null; }
  if (logStream) { logStream.end(); logStream = null; }
  batch = [];
}

// ---- IPC ------------------------------------------------------------------
const run = (cmd, args, timeout = 9000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, env: childEnv() }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() }));
  });

ipcMain.handle('doctor', async () => {
  const out = { claude: { found: false }, codex: { found: false } };
  const c = resolveClaude();
  if (c) {
    const r = await run(c.command, [...c.prefix, '--version']);
    out.claude = { found: r.ok, version: r.out.split('\n')[0] };
  }
  const x = resolveCodex();
  if (x) {
    const v = await run(x.command, [...x.prefix, '--version']);
    const l = await run(x.command, [...x.prefix, 'login', 'status']);
    out.codex = { found: v.ok, version: v.out.split('\n')[0], loggedIn: l.ok, detail: l.out.split('\n')[0] };
  }
  return out;
});

ipcMain.handle('settings', () => readSettings());
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('start', (_e, cfg) => {
  try {
    teardown();
    const demo = !!cfg.demo;
    if (demo && !cfg.cwd) cfg.cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-demo-'));
    if (!cfg.cwd || !fs.existsSync(cfg.cwd)) return { ok: false, error: 'Pick an existing project folder.' };
    if (!cfg.task || !cfg.task.trim()) return { ok: false, error: 'Describe the task first.' };
    room = buildRoom({ ...cfg, speed: demo ? 1 : undefined });
    attach(room);
    const s = readSettings();
    if (!demo) s.recent = [cfg.cwd, ...(s.recent || []).filter((p) => p !== cfg.cwd)].slice(0, 6);
    writeSettings(s);
    room.start(cfg.task.trim());
    return { ok: true, cwd: cfg.cwd };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('send', (_e, msg) => { if (room) room.send(msg); });
ipcMain.handle('interrupt', (_e, id) => { if (room) room.interrupt(id); });
ipcMain.handle('resume', (_e, id) => { if (room) room.resume(id); });
ipcMain.handle('stop-all', () => { if (room) room.stopAll(); });
ipcMain.handle('history', () => (room ? room.history : []));
ipcMain.handle('reset', () => { teardown(); });
ipcMain.handle('open-folder', (_e, p) => shell.openPath(p));

// dev aid: `electron . --demo --shot=out.png --shot-delay=9000` saves a screenshot and exits
const argVal = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');

app.whenReady().then(() => {
  createWindow();
  if (DEMO_FLAG) win.webContents.once('did-finish-load', () => win.webContents.send('auto-demo'));
  const shot = argVal('shot');
  if (shot) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(shot, img.toPNG());
      app.quit();
    }, Number(argVal('shot-delay')) || 6000));
  }
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => { teardown(); app.quit(); });
