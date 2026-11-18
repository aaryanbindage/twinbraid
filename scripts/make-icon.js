'use strict';
// Renders build/icon.png (1024x1024) with Electron's own canvas:  npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const HTML = `<body style="margin:0;background:transparent"><canvas id="c" width="1024" height="1024"></canvas><script>
const c = document.getElementById('c').getContext('2d');
const r = 228;
c.beginPath(); c.roundRect(40, 40, 944, 944, r); c.closePath();
const bg = c.createLinearGradient(0, 0, 0, 1024); bg.addColorStop(0, '#2a2723'); bg.addColorStop(1, '#16150f');
c.fillStyle = bg; c.fill();
c.globalCompositeOperation = 'screen';
const dot = (x, y, col) => { const g = c.createRadialGradient(x, y, 20, x, y, 250); g.addColorStop(0, col); g.addColorStop(1, col); c.fillStyle = col; c.beginPath(); c.arc(x, y, 250, 0, Math.PI * 2); c.fill(); };
dot(400, 512, '#da7756'); dot(624, 512, '#3fb6a0');
</script></body>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  console.log('wrote', out, img.getSize());
  app.quit();
});
