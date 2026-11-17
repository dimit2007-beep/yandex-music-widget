/**
 * Главный процесс Electron:
 * - компактное окно поверх всех окон
 * - локальное состояние: CDP (интерфейс ЯМ) + Windows SMTC; REST API (лайки, поиск)
 * - OAuth-вход с перехватом токена
 * - трей
 */
// отдельное приложение «Часы» живёт в своём процессе (electron . --clock)
if (process.argv.includes('--clock')) {
  require('./clock-main');
  return; // дальше — только музыкальный виджет
}
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  safeStorage,
} = require('electron');
app.disableHardwareAcceleration(); // иначе новые окна иногда не получают кадры (GPU-фриз)
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { YMApi } = require('./ym-api');
const { SmtcWatcher, sendMediaKey } = require('./smtc');
const { CdpWatcher, restartYmWithPort, isYmRunning } = require('./cdp');
const { ForegroundWatcher } = require('./foreground');
const { openMenuPopup } = require('./menu-popup');
const { acquireSingleInstance, notifyFirstInstance } = require('./single-instance');

// диагностика падений дочерних процессов Chromium (renderer/gpu)
app.on('child-process-gone', (_e, details) => {
  console.log('!!! child-process-gone: type=' + details.type + ' reason=' + details.reason + ' exit=' + details.exitCode);
});

// Логи в файл + безопасная консоль (EPIPE, если консоль.attach отвалилась)
const logPath = () => path.join(app.getPath('userData'), 'widget.log');

// ротация: лог растёт без ограничений — при старте разросшийся уводим в .old
try {
  if (fs.existsSync(logPath()) && fs.statSync(logPath()).size > 1e6) {
    fs.renameSync(logPath(), logPath() + '.old');
  }
} catch (_) {}

['log', 'error', 'warn'].forEach((k) => {
  const orig = console[k].bind(console);
  console[k] = (...args) => {
    const stamp = new Date().toLocaleTimeString('ru-RU');
    const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    try {
      fs.appendFile(logPath(), stamp + ' ' + text + '\n', () => {});
    } catch (_) {}
    try {
      orig(stamp, ...args);
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
let api = null;
let cdpWatcher = null;
let ymRestartTimer = null;
let quitting = false;

const userDir = app.getPath('userData');
const tokenFile = path.join(userDir, 'token.json');
const boundsFile = path.join(userDir, 'window.json');
const uiFile = path.join(userDir, 'ui.json');

// настройки вида: buttons — показывать кнопки плеера, opacity — прозрачность фона плашки (%)
const DEFAULT_UI = { buttons: true, opacity: 25, locked: false, display: 'top' };

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

// кэш режима показа: loadUi() читает файл с диска, поэтому на каждый
// mousemove/move его дёргать нельзя
let displayMode = loadUi().display || 'top';

let oauthResolve = null; // promise токена для окна-инпута

function loadToken() {
  try {
    const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    if (data.enc) {
      // зашифрованный вид (safeStorage -> DPAPI Windows). Расшифровать не вышло
      // (перенесли профиль и т.п.) — считаем, что токена нет
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(data.enc, 'base64')) || null;
    }
    return data.token || null; // старый открытый вид — читаем для совместимости
  } catch (_) {
    return null;
  }
}

function saveToken(token) {
  fs.mkdirSync(userDir, { recursive: true });
  let data;
  try {
    // шифруем средствами Windows (DPAPI): токен привязан к пользователю этого
    // компьютера. Шифрование недоступно — пишем открытый текст, как раньше
    if (safeStorage.isEncryptionAvailable()) {
      data = { v: 1, enc: safeStorage.encryptString(token).toString('base64') };
    } else {
      data = { token };
    }
  } catch (_) {
    data = { token };
  }
  fs.writeFileSync(tokenFile, JSON.stringify(data, null, 2));
}

function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(boundsFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

// восстановленные границы проверяем по текущим мониторам: после отключения
// монитора окно может остаться за экраном. Центр не на экране — прижимаем
// к ближайшему workArea. Если ничего не разобрали — null (дефолтные размеры)
function fitBounds(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !b.width || !b.height) return null;
  let displays;
  try {
    displays = screen.getAllDisplays();
  } catch (_) {
    return b;
  }
  if (!displays || !displays.length) return b;
  const areas = displays.map((d) => d.workArea);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const inside = areas.find(
    (wa) => cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height
  );
  if (inside) return b;
  const nearest = areas.reduce((best, wa) => {
    const dx = Math.max(wa.x - cx, 0, cx - (wa.x + wa.width));
    const dy = Math.max(wa.y - cy, 0, cy - (wa.y + wa.height));
    const dist = dx * dx + dy * dy;
    return !best || dist < best.dist ? { wa, dist } : best;
  }, null).wa;
  const x = Math.max(nearest.x, Math.min(b.x, nearest.x + nearest.width - b.width));
  const y = Math.max(nearest.y, Math.min(b.y, nearest.y + nearest.height - b.height));
  return { ...b, x, y };
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

let lastCdpAt = 0;
let lastPushedSampleAt = 0; // receivedAt последнего доставленного в рендерер сэмпла
let lastAlbumHash = null;
let ymAttemptAt = 0;   // последнее вмешательство в ЯМ (kill или запуск)
let ymFailStreak = 0;  // вмешательств подряд без открывшегося порта
let ymFastTries = 0;   // быстрых попыток поднять закрытую ЯМ (старт Windows)

function startServices() {
  if (process.env.YM_NO_SVCS) return; // отладка: без служб (проверка рендера меню)
  stopServices();
  const token = loadToken();
  // REST-обогащение (каноничные имена, артисты, обложка резерва, REST-лайк) —
  // только с токеном. Показ и управление работают и без входа: CDP/SMTC
  // читают состояние, а команды жмут настоящие кнопки в приложении ЯМ.
  api = token ? new YMApi(token) : null;
  pushToRenderer('yp:auth', { ok: !!token });
  // Ynison (серверный пуш «что играет на устройствах») убран: виджет берёт
  // музыку только с этого ПК — CDP из самого приложения ЯМ + SMTC как резерв
  if (!cdpWatcher) {
    cdpWatcher = new CdpWatcher(onCdpState);
    cdpWatcher.start();
  }
  // гарантируем, что ЯМ запущен с дебажным портом. Первая проверка — сразу
  // (через 3 с, дав отработать первому тику CDP): на старте Windows виджет и
  // ЯМ стартуют одновременно, и ждать первой проверки 30 секунд — долго.
  // Дальше раз в 10 с — вызов дешёвый: при живом CDP он сразу выходит.
  setTimeout(ensureYmDebugPort, 3000);
  ymRestartTimer = setInterval(ensureYmDebugPort, 10000);
}

function stopServices() {
  if (cdpWatcher) {
    cdpWatcher.stop();
    cdpWatcher = null;
  }
  if (ymRestartTimer) {
    clearInterval(ymRestartTimer);
    ymRestartTimer = null;
  }
  api = null;
  lastCdpAt = 0;
  lastPushedSampleAt = 0;
  ymAttemptAt = 0;
  ymFailStreak = 0;
  ymFastTries = 0;
}

// сбор состояния: CDP / SMTC + обогащение через REST
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
  // Обогащение REST-звонками занимает время, тики CDP/SMTC идут внахлёст —
  // параллельные deliverState завершаются не по порядку. Не даём устаревшему
  // сэмплу перезаписать уже доставленный более свежий (иначе часы дёргает назад).
  if (st.receivedAt && st.receivedAt < lastPushedSampleAt) {
    console.log('[state] пропущен устаревший сэмпл (' + source + ')');
    return;
  }
  if (st.receivedAt) lastPushedSampleAt = st.receivedAt;
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

// гарантируем, что ЯМ запущена с портом отладки (защищённо от сбоев).
// Различаем два случая по факту: запущена ли ЯМ (tasklist).
//  1) ЯМ запущена БЕЗ порта — её открыли вручную, поднял автозапуск или
//     автообновлятор. Чиним быстро (kill + запуск с портом), пауза между
//     попытками растёт при серии неудач: 0 / 45 / 90 / 180 с, потом 10 мин,
//     чтобы не устроить карусель, если запуск с портом не приживается.
//  2) ЯМ закрыта — запускаем сами, но не навязчиво: пока CDP ни разу не ожил
//     (старт Windows) раз в 60 с, максимум 3 быстрые попытки; дальше раз в
//     10 минут — пользователь мог закрыть ЯМ намеренно, не дёргаем.
async function ensureYmDebugPort() {
  try {
    if (quitting || !cdpWatcher) return;
    if (cdpWatcher.fresh) { ymFailStreak = 0; return; }  // состояние читается — всё живо
    if (cdpWatcher.portUp) { ymFailStreak = 0; return; } // порт есть, ЯМ грузится — не трогать
    const ymRunning = await isYmRunning();
    if (ymRunning) {
      const waits = [0, 45000, 90000, 180000, 600000];
      if (Date.now() - ymAttemptAt < waits[Math.min(ymFailStreak, waits.length - 1)]) return;
    } else {
      const neverOk = !cdpWatcher.lastOkAt;
      if (Date.now() - ymAttemptAt < (neverOk && ymFastTries < 3 ? 60000 : 10 * 60000)) return;
      ymFastTries += 1;
    }
    ymAttemptAt = Date.now();
    ymFailStreak += 1; // сбросится, как только порт откроется и состояние пойдёт
    restartYmWithPort()
      .then((res) => {
        if (res === 'restarted') console.log('[cdp] перезапустил Яндекс Музыку с портом отладки');
        else if (res === 'started') console.log('[cdp] запустил Яндекс Музыку с портом отладки (сама была закрыта)');
        else if (res === 'not-found') console.error('[cdp] Яндекс Музыка не найдена для автозапуска');
      })
      .catch((e) => console.error('[cdp] restart: ' + (e.message || e)));
  } catch (e) {
    console.error('[cdp] restart guard: ' + e.message);
  }
}

async function onCdpState(st) {
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

async function onSmtcState(st) {
  if (!st) {
    // «ничего не играет»: если CDP давно молчит (ЯМ закрыт) — гасим плашку
    // до «Пока тишина…», а не держим застывший трек
    if (Date.now() - lastCdpAt > 15000) {
      await deliverState({ trackId: null, title: null, paused: true }, 'empty');
    }
    return;
  }
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
    ...(fitBounds(bounds) || {}),
    minWidth: 300,
    minHeight: 96,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    focusable: false, // клик по виджету не крадёт фокус у активного приложения
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
    // и актуальный режим стол/окна: событие от FG-смотрителя могло прийти
    // раньше, чем страница загрузилась и подписалась — тогда оно терялось
    pushToRenderer('yp:fgmode', fgNow);
  });
  // ПКМ по виджету — popup-меню у курсора (renderer шлёт координаты)
  // (сам renderer вызывает 'ym:openMenu'; см. IPC-секцию)
}

// пункты ПКМ-меню виджета для popup-окна
function buildMusicMenuItems(ui, authorized) {
  const OPACITIES = [0, 5, 10, 25, 40, 60, 80, 100];
  const items = [
    { id: 'toggle', label: 'Показать/скрыть' },
    { type: 'sep' },
    { id: 'buttons', label: 'Показывать кнопки', checked: !!ui.buttons },
    {
      id: 'opacity',
      label: 'Прозрачность фона',
      items: OPACITIES.map((v) => ({
        id: 'opacity-' + v,
        label: v >= 100 ? 'Непрозрачный (100%)' : v === 0 ? 'Полностью прозрачный (0%)' : `Дымка ${v}%`,
        checked: ui.opacity === v,
      })),
    },
    {
      id: 'display-desktop',
      label: 'Только рабочий стол',
      checked: ui.display === 'desktop',
    },
    { id: 'lock', label: 'Зафиксировать положение', checked: !!ui.locked },
    { type: 'sep' },
    { id: 'restart', label: 'Перезапустить виджет' },
    ...(authorized
      ? [{ id: 'logout', label: 'Сбросить токен (выйти)' }]
      : [{ id: 'login', label: 'Вход через Яндекс…' }]),
    { type: 'sep' },
    { id: 'quit', label: 'Закрыть виджет' },
  ];
  return items;
}

function onMusicMenuPick(id) {
  if (id === 'toggle') return toggleWin();
  if (id === 'buttons') return applyUi({ buttons: !loadUi().buttons });
  if (id === 'lock') return applyUi({ locked: !loadUi().locked });
  if (id === 'restart') return restartWidgetNow();
  if (id === 'login') return openLogin();
  if (id === 'logout') return logout();
  if (id === 'quit') {
    quitting = true;
    app.quit();
    return;
  }
  const m = /^opacity-(\d+)$/.exec(id);
  if (m) return applyUi({ opacity: Number(m[1]) });
  // «Только рабочий стол» — переключатель: галочка стоит = показываем и поверх окон
  if (id === 'display-desktop') {
    return applyUi({ display: loadUi().display === 'desktop' ? 'top' : 'desktop' });
  }
}

// меню поверх нефокусируемого окна: на время открытия делаем окно фокусируемым,
// иначе меню не захватывает клики и не закрывается кликом в сторону
function popupOn(wnd, menu) {
  try { wnd.setFocusable(true); } catch (_) {}
  menu.popup({ window: wnd });
  menu.once('menu-will-close', () => {
    try { wnd.setFocusable(false); } catch (_) {}
  });
}

// «Режим показа»: 'top' — всегда поверх приложений; 'desktop' — плашка живёт
// в общем слое окон, как виджет рабочего стола: видна над обоями, а любое
// наехавшее окно — активное или нет — накрывает её штатно, силами самой
// Windows. Поэтому перекрытие всегда плавное и точное: без «дырок», опроса
// и пересчётов — ровно как окна перекрывают друг друга
let fgNow = 'window';   // что сейчас активно (от ForegroundWatcher) — для клик-сквози
let userHidden = false; // пользователь сам скрыл виджет («Показать/скрыть»)

function applyDisplayMode() {
  if (!win || win.isDestroyed()) return;
  const mode = displayMode;
  const desktop = mode === 'desktop' && !userHidden;
  // 'desktop': окно не topmost — перекрытие делает сама Windows;
  // 'top': снова поверх всех окон
  if (desktop && win.isAlwaysOnTop()) win.setAlwaysOnTop(false);
  if (!desktop && !win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver');
  if (userHidden) {
    if (win.isVisible()) win.hide();
    return;
  }
  if (!win.isVisible()) { console.log('[disp] show (mode=' + mode + ')'); win.showInactive(); }
}

// поднять окно наверх его зоны. moveTop/HWND_TOP для нашего окна (no-activate,
// toolwindow) не срабатывает — проверено тестом; надёжно работает трюк
// «мгновение topmost, затем не-topmost»: окно оказывается на самом верху
// normal-банды, над соседними окнами, как при клике на обычное окно
function raiseWindow() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  if (displayMode === 'desktop' && !userHidden) win.setAlwaysOnTop(false);
}

function applyUi(patch) {
  console.log('[applyUi] patch=' + JSON.stringify(patch));
  const ui = { ...loadUi(), ...patch };
  saveUi(ui);
  displayMode = ui.display || 'top';
  if (patch && patch.display) userHidden = false; // сменили режим — показываем по нему
  if (tray) tray.setContextMenu(buildTrayMenu());
  if (win && win.applyUi) win.applyUi(ui);
  pushToRenderer('yp:ui', ui);
  applyDisplayMode();
}

// перезапуск виджета: прямой detached-спавн нового экземпляра electron.
// (app.relaunch передаёт аргументы с чужим cwd и падает; запуск через
// detached powershell не выживает, когда родитель сразу выходит из app.quit —
// проверено тестом: прямой спавн переживает, powershell-прослойка умирает)
function restartWidgetNow() {
  quitting = true;
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [__dirname], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (e) => console.error('[restart] spawn error: ' + (e.stack || e.message)));
  child.unref();
  app.quit();
}

// принудительный перезапуск ЯМ из меню (с портом отладки; поднимает, если закрыта)
function restartYmNow() {
  lastCdpAt = 0; // источник временно недоступен — переходим на резерв
  restartYmWithPort(true)
    .then((res) => {
      if (res === 'restarted') console.log('[cdp] перезапустил Яндекс Музыку (manual)');
      else if (res === 'started') console.log('[cdp] запустил Яндекс Музыку (manual, сама была закрыта)');
      else if (res === 'not-found') console.error('[cdp] restart ЯМ (manual): exe не найден');
    })
    .catch((e) => console.error('[cdp] restart ЯМ (manual): ' + (e.message || e)));
}

function buildTrayMenu() {
  const ui = loadUi();
  const authorized = !!loadToken();
  const OPACITIES = [0, 5, 10, 25, 40, 60, 80, 100];
  return Menu.buildFromTemplate([
    { label: 'Показать/скрыть', click: toggleWin },
    { type: 'separator' },
    {
      label: 'Кнопки управления',
      submenu: [
        { label: 'Показывать кнопки', type: 'radio', checked: !!ui.buttons, click: () => applyUi({ buttons: true }) },
        { label: 'Без кнопок (только трек)', type: 'radio', checked: !ui.buttons, click: () => applyUi({ buttons: false }) },
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
      label: 'Только рабочий стол',
      type: 'checkbox',
      checked: ui.display === 'desktop',
      click: () => applyUi({ display: ui.display === 'desktop' ? 'top' : 'desktop' }),
    },
    {
      label: 'Зафиксировать положение',
      type: 'checkbox',
      checked: !!ui.locked,
      click: () => applyUi({ locked: !loadUi().locked }),
    },
    { type: 'separator' },
    { label: 'Перезапустить виджет', click: restartWidgetNow },
    ...(authorized
      ? [{ label: 'Сбросить токен (выйти)', click: logout }]
      : [{ label: 'Вход через Яндекс…', click: openLogin }]),
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
  console.log('[toggle] isVisible=' + win.isVisible() + ' userHidden=' + userHidden + ' fg=' + fgNow);
  if (win.isVisible()) {
    userHidden = true; // сам скрыл — автопоказ режима не перебивает
    win.hide();
  } else {
    userHidden = false;
    win.show();
    applyDisplayMode();
    raiseWindow(); // подняться над соседними в общем слое (режим «desktop»)
  }
}

// ---------------- IPC ----------------

// текущие настройки вида (кнопки/прозрачность)
ipcMain.handle('ui:getUi', () => loadUi());

// клик-сквозь окна виджета: true = пропускать клики (кроме наведения на кнопки)
ipcMain.handle('ui:ignoreMouse', (_e, v) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!v, { forward: true });
});

// пункты ПКМ-меню (меню теперь рисует сам renderer, а тут исполнение)
ipcMain.handle('ym:applyUi', (_e, patch) => applyUi(patch));
ipcMain.handle('ym:toggleWin', () => toggleWin());
ipcMain.handle('ym:restartYm', () => restartYmNow());
ipcMain.handle('ym:logout', () => logout());
ipcMain.handle('ym:quit', () => { quitting = true; app.quit(); });

// ПКМ: popup-меню у курсора (закрывается любым кликом снаружи)
ipcMain.handle('ym:openMenu', async (_e, x, y) => {
  if (!win || win.isDestroyed()) return;
  openMenuPopup({
    x: Number(x),
    y: Number(y),
    payload: { items: buildMusicMenuItems(loadUi(), !!loadToken()) },
    onPick: onMusicMenuPick,
    onClose: () => {},
  });
});

// ручное перетаскивание
ipcMain.handle('ym:getPosition', () => {
  if (!win || win.isDestroyed()) return null;
  return win.getPosition();
});
// взятись за плашку — подняться над соседними в общем слое окон (режим «desktop»),
// как у обычного окна: клик выводит его наверх
ipcMain.handle('ym:raise', () => {
  if (win && !win.isDestroyed()) raiseWindow();
});
ipcMain.on('ym:moveTo', (_e, x, y) => {
  if (!win || win.isDestroyed()) return;
  if (loadUi().locked) return; // зафиксировано — не двигаем
  const nx = Math.round(Number(x));
  const ny = Math.round(Number(y));
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
  win.setPosition(nx, ny, false);
});

// управление: CDP (клики в приложении), затем системные media-клавиши
let ctlCtl;
function chooseCtl() {
  if (cdpWatcher && cdpWatcher.fresh && Date.now() - lastCdpAt < 30000) return 'cdp';
  return 'keys';
}

ipcMain.handle('ctl:pause', async () => {
  const c = chooseCtl();
  if (c === 'cdp') return cdpWatcher.playPause();
  sendMediaKey('playPause');
});
ipcMain.handle('ctl:play', async () => {
  const c = chooseCtl();
  if (c === 'cdp') return cdpWatcher.playPause();
  sendMediaKey('playPause');
});
ipcMain.handle('ctl:next', async () => {
  const c = chooseCtl();
  if (c === 'cdp') return cdpWatcher.next();
  sendMediaKey('next');
});
ipcMain.handle('ctl:prev', async () => {
  const c = chooseCtl();
  if (c === 'cdp') return cdpWatcher.prev();
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

app.whenReady().then(async () => {
  // один экземпляр на систему: повторный запуск (npm start поверх портативной
  // сборки и т.п.) просит первый показаться и закрывается. Свой лок через
  // именованный pipe, а не requestSingleInstanceLock: тот держит лок на папке
  // userData, которую делят виджет и часы — часы бы не запустились.
  const first = await acquireSingleInstance('widget', () => {
    if (!win || win.isDestroyed()) return;
    userHidden = false;
    win.show();
    applyDisplayMode();
    raiseWindow();
  });
  if (!first) {
    const told = await notifyFirstInstance('widget');
    if (told) {
      console.log('[single] виджет уже запущен — попросил показать окно, выходим');
      app.quit();
      return;
    }
    console.log('[single] лок не взят, но живого экземпляра не нашли — работаем без единственности');
  }
  // автозапуск — ярлыком в каталоге «Автозагрузка» (создаётся отдельно),
  // а через setLoginItemSettings не прописываем: он создавал безымянный
  // реестровый ключ Run без иконки.
  createWindow();
  applyDisplayMode(); // применить сохранённый режим показа (top/desktop)
  createTray();
  startServices();
  // резервный источник «что играет» — Windows SMTC (работает без токена)
  if (!process.env.YM_NO_SVCS) {
    const smtc = new SmtcWatcher(onSmtcState);
    smtc.start();
    // рабочий стол vs другие окна — управление клик-сквозью
    // (окна самого виджета — меню, окно входа — считаем рабочим столом)
    const fg = new ForegroundWatcher((info) => {
      fgNow = info.mode === 'desktop' ? 'desktop' : 'window';
      if (win && !win.isDestroyed()) win.webContents.send('yp:fgmode', fgNow);
    }, process.pid);
    fg.start();
  }
});

app.on('before-quit', () => {
  saveBounds();
  quitting = true;
});

app.on('window-all-closed', (e) => {
  // виджет живёт в трее
});

if (process.send) process.on('SIGTERM', () => app.quit()); // для разработки
