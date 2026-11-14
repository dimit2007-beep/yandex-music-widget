const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ym', {
  // события от главного процесса
  onState: (cb) => ipcRenderer.on('yp:state', (_e, s) => cb(s)),
  onAuth: (cb) => ipcRenderer.on('yp:auth', (_e, a) => cb(a)),
  onFgMode: (cb) => ipcRenderer.on('yp:fgmode', (_e, m) => cb(m)),
  // «дырка» под активное окно в режиме «только рабочий стол»: { hole, clip } | null
  onFgHole: (cb) => ipcRenderer.on('yp:fghole', (_e, d) => cb(d)),
  onUi: (cb) => ipcRenderer.on('yp:ui', (_e, u) => cb(u)),

  // действия
  uiState: () => ipcRenderer.invoke('ui:getUi'),
  ignoreMouse: (v) => ipcRenderer.invoke('ui:ignoreMouse', v),
  pause: () => ipcRenderer.invoke('ctl:pause'),
  play: () => ipcRenderer.invoke('ctl:play'),
  next: () => ipcRenderer.invoke('ctl:next'),
  prev: () => ipcRenderer.invoke('ctl:prev'),
  setLike: (trackId, liked) => ipcRenderer.invoke('ctl:setLike', trackId, liked),
  login: () => ipcRenderer.invoke('ui:login'),
  authState: () => ipcRenderer.invoke('ui:getAuthState'),

  // ПКМ по виджету: открыть popup-меню у курсора
  openMenu: (x, y) => ipcRenderer.invoke('ym:openMenu', x, y),

  // настройки и действия меню (ПКМ)
  applyUi: (patch) => ipcRenderer.invoke('ym:applyUi', patch),
  toggleWin: () => ipcRenderer.invoke('ym:toggleWin'),
  restartYm: () => ipcRenderer.invoke('ym:restartYm'),
  logout: () => ipcRenderer.invoke('ym:logout'),
  quit: () => ipcRenderer.invoke('ym:quit'),

  // ручное перетаскивание (drag-области глотали ПКМ)
  getPosition: () => ipcRenderer.invoke('ym:getPosition'),
  moveTo: (x, y) => ipcRenderer.send('ym:moveTo', x, y),
});
