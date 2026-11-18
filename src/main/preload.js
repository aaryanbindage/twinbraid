'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('duet', {
  platform: process.platform,
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  onEvents: (cb) => ipcRenderer.on('events', (_e, batch) => cb(batch)),
  onAutoDemo: (cb) => ipcRenderer.on('auto-demo', (_e, opts) => cb(opts || {})),
});
