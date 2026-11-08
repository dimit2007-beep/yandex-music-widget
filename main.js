/**
 * Главный процесс Electron:
 * - компактное окно поверх всех окон
 * -ервисы Ynison (текущий трек) и REST API (мета, лайки)
 * - OAuth-вход с перехватом токена
 * - трей
 */
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { Ynison } = require('./ynison');
const { YMApi } = require('./ym-api');
const { SmtcWatcher, sendMediaKey } = require('./smtc');
const { CdpWatcher, buildRestartPs } = require('./cdp');
const { ForegroundWatcher } = require('./foreground');

// Логи в файл + безопасная консоль (EPIPE, если консоль.attach отвалилась)
const logPath = () => path.join(app.getPath('userData'), 'widget.log');
['log', 'error', 'warn'].forEach((k) => {
  const orig = console[k].bind(console);
  console[k] = (...args) => {
    try {
      fs.appendFile(logPath(), args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n', () => {});
    } catch (_) {}
    try {
      orig(...args);
    } catch (_) {}
  };
});
process.on('uncaughtException', (e) => {
  if (e && (e.code === 'EPIPE' || /EPIPE/i.test(String(e.message || '')))) return;
  console.error('uncaught:', e && (e.stack || e.message) || e);
});

const OAUTH_URL =
  'https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d';

let win = null;
let oauthWin = null;
let tray = null;
let ynison = null;
let api = null;
let cdpWatcher = null;
let ymRestartTimer = null;
let quitting = false;

const userDir = app.getPath('userData');
const tokenFile = path.join(userDir, 'token.json');
const boundsFile = path.join(userDir, 'window.json');
const uiFile = path.join(userDir, 'ui.json');

// настройки вида: buttons — показывать кнопки плеера, opacity — прозрачность фона плашки (%)
const DEFAULT_UI = { buttons: true, opacity: 25, locked: false };

function loadUi() {
  try {
    return { ...DEFAULT_UI, ...JSON.parse(fs.readFileSync(uiFile, 'utf8')) };
  } catch (_) {
    return { ...DEFAULT_UI };
  }
}

function saveUi(ui) {
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(uiFile, JSON.stringify(ui, null, 2));
}

let oauthResolve = null; // promise токена для окна-инпута

function loadToken() {
  try {
    return JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token || null;
  } catch (_) {
    return null;
  }
}

function saveToken(token) {
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify({ token }, null, 2));
}

function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(boundsFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    fs.writeFileSync(boundsFile, JSON.stringify(win.getBounds()));
  } catch (_) {}
}

function pushToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------- сервисы ----------------

let lastYnisonAt = 0; // свежесть Ynison-состояния (если актуально — приоритет над SMTC)
let lastCdpAt = 0;
let lastAlbumHash = null;
let ymRelaunchedAt = 0; // ставим перезапуск ЯМ не чаще раза в 10 минут

function startServices() {
  stopServices();
  const token = loadToken();
  api = new YMApi(token); // даже без токена SMTC всё равно показывает трек
  pushToRenderer('yp:auth', { ok: !!token });
  if (token) {
    ynison = new Ynison(token, onYnisonState);
    ynison.start();
  }
  if (!cdpWatcher) {
    cdpWatcher = new CdpWatcher(onCdpState);
    cdpWatcher.start();
  }
  // раз в полминуты гарантируем, что ЯМ запущен с дебажным портом
  ymRestartTimer = setInterval(ensureYmDebugPort, 30000);
}

function stopServices() {
  if (ynison) {
    ynison.stop();
    ynison = null;
  }
  if (cdpWatcher) {
    cdpWatcher.stop();
    cdpWatcher = null;
  }
  if (ymRestartTimer) {
    clearInterval(ymRestartTimer);
    ymRestartTimer = null;
  }
  api = null;
  lastYnisonAt = 0;
  lastCdpAt = 0;
}

// единая отправка состояния (Ynison / CDP / SMTC + обогащение из REST)
async function deliverState(st, source) {
  let track = null;
  let liked = st.liked === true || false;
  let trackId = st.trackId || null;
  if (api && trackId) {
    try {
      track = await api.getTrack(trackId);
      const likedIds = await api.getLikedIds().catch(() => null);
      liked = !!(likedIds && likedIds.has(String(trackId)));
    } catch (e) {
      console.error('[api] ' + e.message);
    }
  }
  let artists = (track && track.artists) || st.artists || null;
  // CDP даёт albumId: добираем артистов через REST альбома
  if (!artists && st.albumHref && api) {
    const m = /albumId=(\d+)/.exec(st.albumHref);
    if (m) {
      try {
        const alb = await api.getAlbum(m[1]);
        artists = alb ? alb.artists : null;
      } catch (_) {}
    }
  }
  // CDP не даёт trackId — ищем трек по названию (каноничный title + для лайка)
  if (!trackId && st.title && api) {
    trackId = await api
      .findTrack(st.title, typeof artists === 'string' ? artists : null)
      .catch(() => null);
    if (trackId && !track) {
      track = await api.getTrack(trackId).catch(() => null); // каноничное имя трека
    }
  }
  // Засада: бар приложения иногда даёт «Артисты — Трек» одним полем.
  // Если REST-трека нет, но строка начинается с артистов — отрежем префикс.
  let title = (track && track.title) || st.title || null;
  if (!track && title && artists && typeof artists === 'string' && title.startsWith(artists)) {
    title = title.slice(artists.length).replace(/^[\s—–-]+/, '');
  }
  pushToRenderer('yp:state', {
    trackId,
    title,
    artists,
    album: (track && track.album) || st.album || null,
    cover: (track && track.cover) || st.cover || null,
    durationMs: (track && track.durationMs) || st.durationMs || 0,
    progressMs: st.progressMs || 0,
    playbackSpeed: st.playbackSpeed || 1,
    timestampMs: st.timestampMs || st.receivedAt,
    receivedAt: st.receivedAt,
    paused: !!st.paused,
    liked,
    source,
  });
}

// перезапуск ЯМ с портом отладки, если запущен без него (защищённо от сбоев)
function ensureYmDebugPort() {
  try {
    if (quitting) return;
    if (cdpWatcher && cdpWatcher.fresh) return;
    if (Date.now() - ymRelaunchedAt < 10 * 60000) return;
    const { spawn } = require('child_process');
    const enc = Buffer.from(buildRestartPs(), 'utf16le').toString('base64');
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true })
      .stdout.on('data', (d) => {
        if (String(d).includes('restarted')) {
          ymRelaunchedAt = Date.now();
          console.log('[cdp] перезапустил Яндекс Музыку с портом отладки');
        }
      });
    ymRelaunchedAt = Date.now(); // не чаще раза в 10 минут в любом случае
  } catch (e) {
    console.error('[cdp] restart guard: ' + e.message);
  }
}

async function onCdpState(st) {
  if (Date.now() - lastYnisonAt < 45000) return; // Ynison приоритетнее
  lastCdpAt = Date.now();
  await deliverState(
    {
      trackId: null,
      title: st.title,
      cover: st.cover,
      albumHref: st.albumHref,
      progressMs: st.progressMs,
      durationMs: st.durationMs,
      timestampMs: st.ts,
      receivedAt: st.receivedAt,
      paused: st.paused,
      liked: st.liked,
    },
    'cdp'
  );
}

async function onYnisonState(st) {
  lastYnisonAt = Date.now();
  await deliverState(
    {
      trackId: st.trackId,
      progressMs: st.progressMs,
      playbackSpeed: st.playbackSpeed,
      timestampMs: st.timestampMs,
      receivedAt: st.receivedAt,
      paused: st.paused,
    },
    'ynison'
  );
}

async function onSmtcState(st) {
  if (!st) {
    // «ничего не играет»: если и CDP давно молчит (ЯМ закрыт) и Ynison свежим
    // не был — гасим плашку до «Пока тишина…», а не держим застывший трек
    if (Date.now() - lastCdpAt > 15000 && Date.now() - lastYnisonAt > 45000) {
      await deliverState({ trackId: null, title: null, paused: true }, 'empty');
    }
    return;
  }
  if (Date.now() - lastYnisonAt < 45000) return; // Ynison актуален — пропускаем
  await deliverState(
    {
      trackId: null,
      title: st.title,
      artists: st.artists,
      album: st.album,
      progressMs: st.progressMs,
      durationMs: st.durationMs,
      timestampMs: st.ts,
      receivedAt: st.receivedAt,
      paused: st.paused,
    },
    'smtc'
  );
}

// ---------------- окно OAuth ----------------

function openLogin() {
  if (oauthWin) {
    oauthWin.focus();
    return;
  }
  oauthWin = new BrowserWindow({
    width: 500,
    height: 720,
    title: 'Вход в Яндекс Музыку',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  oauthWin.removeMenu();
  let done = false;
  const grab = async () => {
    if (done) return;
    try {
      const wc = oauthWin.webContents;
      const url = wc.getURL() || '';
      if (!/^https:\/\/music\.yandex\./.test(url)) return;
      const hash = (await wc.executeJavaScript('location.hash', false)) || '';
      const m = /access_token=([^&\s]+)/.exec(url + hash);
      if (m && m[1]) {
        done = true;
        saveToken(m[1]);
        startServices();
        pushToRenderer('yp:auth', { ok: true });
        if (oauthWin) oauthWin.close();
      }
    } catch (_) {}
  };
  oauthWin.webContents.on('did-navigate', grab);
  oauthWin.webContents.on('did-navigate-in-page', grab);
  oauthWin.on('closed', () => {
    oauthWin = null;
  });
  oauthWin.loadURL(OAUTH_URL);
}

function logout() {
  try { fs.unlinkSync(tokenFile); } catch (_) {}
  stopServices();
  pushToRenderer('yp:auth', { ok: false });
}

// ---------------- иконка трей (PNG на лету, без файлов) ----------------

// минимальный PNG-энкодер (RGBA, bit depth 8)
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makeTrayIcon() {
  const size = 32;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit, RGBA
  // жёлтая скруглённая плашка с чёрной нотой
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // фильтр none
    for (let x = 0; x < size; x++) {
      const p = rowStart + 1 + x * 4;
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      const inside = dx + dy >= 5;
      const note = (() => {
        // простая нота: вертикаль у x∈[13,17], головка — круг ниже
        if (y >= 6 && y <= 20 && x >= 13 && x <= 16 && (x !== 13 || y > 8)) return true;
        const cx = 13, cy = 21, r = (x - cx) ** 2 + (y - cy) ** 2;
        return y >= 16 && y <= 24 && r <= 26 && r >= 1;
      })();
      raw[p + 0] = inside ? (note ? 20 : 255) : 0;
      raw[p + 1] = inside ? (note ? 20 : 199) : 0;
      raw[p + 2] = inside ? (note ? 20 : 0) : 0;
      raw[p + 3] = inside ? 255 : 0;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return nativeImage.createFromBuffer(png);
}

// ---------------- окно виджета ----------------

function createWindow() {
  const bounds = loadBounds();
  win = new BrowserWindow({
    width: 430,
    height: 118,
    useContentSize: true,
    ...(bounds || {}),
    minWidth: 300,
    minHeight: 96,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    title: 'Яндекс Музыка',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile('index.html');
  // размер и позиция сохраняются debounce'ом (важно при жёстком рестарте виджета)
  let boundsTimer = null;
  const saveBoundsSoon = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 500);
  };
  win.on('resize', saveBoundsSoon);
  win.on('move', saveBoundsSoon);
  win.on('close', saveBounds);
  win.applyUi = (ui) => {
    if (win.isDestroyed()) return;
    win.setMovable(!ui.locked);      // фиксируем перетаскивание окна
    win.setResizable(!ui.locked);    // и изменение размера тоже, раз «зафиксировано»
  };
  win.applyUi(loadUi()); // применить сохранённую фиксацию сразу
  win.webContents.on('did-finish-load', () => {
    pushToRenderer('yp:ui', loadUi()); // применить сохранённый вид
  });
  // ПКМ по виджету — то же меню, что и у значка в трее
  win.webContents.on('context-menu', (e) => {
    e.preventDefault();
    buildTrayMenu().popup({ window: win });
  });
}

function applyUi(patch) {
  const ui = { ...loadUi(), ...patch };
  saveUi(ui);
  if (tray) tray.setContextMenu(buildTrayMenu());
  if (win && win.applyUi) win.applyUi(ui);
  pushToRenderer('yp:ui', ui);
}

// принудительный перезапуск ЯМ из меню (с портом отладки; поднимает, если закрыта)
function restartYmNow() {
  try {
    const { spawn } = require('child_process');
    const enc = Buffer.from(buildRestartPs(true), 'utf16le').toString('base64');
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true })
      .stdout.on('data', (d) => {
        const s = String(d).trim();
        if (s) console.log('[cdp] restart ЯМ (manual): ' + s);
        lastCdpAt = 0; // источник временно недоступен — переходим на резерв
      });
  } catch (e) {
    console.error('[cdp] restart ЯМ: ' + e.message);
  }
}

function buildTrayMenu() {
  const ui = loadUi();
  const OPACITIES = [0, 5, 10, 25, 40, 60, 80, 100];
  return Menu.buildFromTemplate([
    { label: 'Показать/скрыть', click: toggleWin },
    { type: 'separator' },
    {
      label: 'Кнопки управления',
      submenu: [
        { label: 'Показывать кнопки', type: 'checkbox', checked: !!ui.buttons, click: () => applyUi({ buttons: true }) },
        { label: 'Без кнопок (только трек)', type: 'checkbox', checked: !ui.buttons, click: () => applyUi({ buttons: false }) },
      ],
    },
    {
      label: 'Прозрачность фона',
      submenu: OPACITIES.map((v) => ({
        label: v >= 100 ? 'Непрозрачный (100%)' : v === 0 ? 'Полностью прозрачный (0%)' : `Дымка ${v}%`,
        type: 'checkbox',
        checked: ui.opacity === v,
        click: () => applyUi({ opacity: v }),
      })),
    },
    {
      label: 'Зафиксировать положение',
      type: 'checkbox',
      checked: !!ui.locked,
      click: () => applyUi({ locked: !loadUi().locked }),
    },
    { type: 'separator' },
    { label: 'Перезапустить Яндекс Музыку', click: restartYmNow },
    { label: 'Вход через Яндекс…', click: openLogin },
    { label: 'Сбросить токен (выйти)', click: logout },
    { type: 'separator' },
    { label: 'Закрыть виджет', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  if (tray) return;
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Яндекс Музыка · виджет');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', toggleWin);
}

function toggleWin() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
}

// ---------------- IPC ----------------

// текущие настройки вида (кнопки/прозрачность)
ipcMain.handle('ui:getUi', () => loadUi());

// клик-сквозь окно: true = пропускать клики (кроме моментов наведения на кнопки)
ipcMain.handle('ui:ignoreMouse', (_e, v) => {  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!v, { forward: true });
});

// приоритет: свежий Ynison → CDP (десктоп-ЯМ) → системные media-клавиши
let ctlCtl;
function chooseCtl() {
  if (cdpWatcher && cdpWatcher.fresh && Date.now() - lastCdpAt < 30000) return 'cdp';
  if (ynison && Date.now() - lastYnisonAt < 45000) return 'ynison';
  return 'keys';
}

ipcMain.handle('ctl:pause', async () => {
  const c = chooseCtl();
  if (c === 'cdp') return cdpWatcher.playPause();
  if (c === 'ynison') return ynison.pause();
  sendMediaKey('playPause');
});
ipcMain.handle('ctl:play', async () => {
  const c = chooseCtl();
  if (c === 'cdp') return cdpWatcher.playPause();
  if (c === 'ynison') return ynison.play();
  sendMediaKey('playPause');
});
ipcMain.handle('ctl:next', async () => {
  const c = chooseCtl();
  if (c === 'cdp') return cdpWatcher.next();
  if (c === 'ynison') return ynison.next();
  sendMediaKey('next');
});
ipcMain.handle('ctl:prev', async () => {
  const c = chooseCtl();
  if (c === 'cdp') return cdpWatcher.prev();
  if (c === 'ynison') return ynison.prev();
  sendMediaKey('prev');
});
ipcMain.handle('ctl:setLike', async (_e, trackId, liked) => {
  if (chooseCtl() === 'cdp') {
    const ok = await cdpWatcher.toggleLike().catch(() => false);
    if (ok) return true;
  }
  return api && trackId
    ? api.setLike(trackId, liked).then(() => true).catch((err) => {
        console.error('[api] лайк: ' + err.message);
        return false;
      })
    : Promise.resolve(false);
});
ipcMain.handle('ui:login', () => openLogin());
ipcMain.handle('ui:getAuthState', () => Promise.resolve({ ok: !!loadToken() }));

// ---------------- рантайм ----------------

nativeTheme.themeSource = 'dark';

app.whenReady().then(() => {
  // автозапуск — ярлыком в каталоге «Автозагрузка» (создаётся отдельно),
  // а через setLoginItemSettings не прописываем: он создавал безымянный
  // реестровый ключ Run без иконки.
  createWindow();
  createTray();
  startServices();
  // резервный источник «что играет» — Windows SMTC (работает без токена)
  const smtc = new SmtcWatcher(onSmtcState);
  smtc.start();
  // рабочий стол vs другие окна — управление click-through
  const fg = new ForegroundWatcher((mode) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('yp:fgmode', mode === 'desktop' ? 'desktop' : 'window');
    }
  });
  fg.start();
});

app.on('before-quit', () => {
  saveBounds();
  quitting = true;
});

app.on('window-all-closed', (e) => {
  // виджет живёт в трее
});

if (process.send) process.on('SIGTERM', () => app.quit()); // для разработки
