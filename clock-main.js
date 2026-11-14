/**
 * Отдельное приложение «Часы» (точка входа: electron . --clock).
 * - компактное окно поверх всех окон: текущее время ЧЧ:ММ
 * - на рабочем столе интерактивно (перетаскивание), поверх приложений — клик-сквозь
 * - свой трей и ПКМ-меню: прозрачность, фиксация, закрыть
 * - настройки и границы помнит в %APPDATA%\yandex-music-widget
 */
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeTheme,
} = require('electron');
app.disableHardwareAcceleration(); // иначе новые окна (popup-меню) не получают кадры (GPU-фриз)
const path = require('path');
const fs = require('fs');
const { ForegroundWatcher } = require('./foreground');
const { openMenuPopup } = require('./menu-popup');
const { computeHole, buildClip } = require('./fg-clip');

// диагностика падений дочерних процессов Chromium (renderer/gpu)
app.on('child-process-gone', (_e, details) => {
  log('!!! child-process-gone: type=' + details.type + ' reason=' + details.reason + ' exit=' + details.exitCode);
});

const userDir = app.getPath('userData');
const boundsFile = path.join(userDir, 'clock.json'); // границы окна
const uiFile = path.join(userDir, 'clock-ui.json'); // { opacity, locked }

// журнал часов (безопасная запись)
const logFile = path.join(userDir, 'clock.log');
const log = (msg) => {
  try {
    fs.appendFileSync(logFile, `[${new Date().toLocaleTimeString()}] ${msg}\n`);
  } catch (_) {}
};

const DEFAULT_UI = { opacity: 25, locked: false, display: 'top' };
const OPACITIES = [0, 5, 10, 25, 40, 60, 80, 100];

let win = null;
let tray = null;
let quitting = false;
// режим показа («только рабочий стол») — полностью независимо от виджета музыки
let fgNow = 'window';   // что сейчас активно (от ForegroundWatcher)
let fgRect = null;      // границы активного окна в DIP { x, y, w, h } | null
let userHidden = false; // пользователь сам скрыл часы
let menuOpen = false;   // открыто меню часов — в режиме «desktop» не прятать

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

// кэш режима показа: loadUi() читает файл с диска, на каждый move не дёргаем
let displayMode = loadUi().display || 'top';

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

function applyUi(patch) {
  const ui = { ...loadUi(), ...patch };
  saveUi(ui);
  displayMode = ui.display || 'top';
  if (patch && patch.display) userHidden = false; // сменили режим — показываем по нему
  if (tray) tray.setContextMenu(buildUiMenu());
  if (win && win.applyUi) win.applyUi(ui);
  if (win && !win.isDestroyed()) win.webContents.send('yp:ui', ui);
  applyDisplayMode();
}

// «Только рабочий стол»: часы видны на рабочем столе; наехавшее окно прячет
// только перекрытую часть (прозрачная «дырка»), целиком накрыло — прячем целиком
let lastHole = null; // последний payload «дырки» { hole, clip } | null

function sendFgHole(payload) {
  lastHole = payload || null;
  if (win && !win.isDestroyed()) win.webContents.send('yp:fghole', payload || null);
}

function applyDisplayMode() {
  if (!win || win.isDestroyed()) return;
  const mode = displayMode;
  if (mode !== 'desktop' || userHidden) {
    sendFgHole(null);
    if (userHidden) {
      if (win.isVisible()) win.hide();
      return;
    }
    if (!win.isVisible()) win.showInactive();
    return;
  }
  // на рабочем столе, при открытом меню или без данных об окне — целиком видны
  if (menuOpen || fgNow === 'desktop' || !fgRect) {
    if (!win.isVisible()) { log('[disp] show (desktop/menu)'); win.showInactive(); }
    sendFgHole(null);
    return;
  }
  // активно чужое окно: вырезаем дырку под перекрытую часть
  const b = win.getBounds();
  const hole = computeHole(b, fgRect);
  if (!hole) {
    if (!win.isVisible()) { log('[disp] show (no overlap)'); win.showInactive(); }
    sendFgHole(null);
    return;
  }
  const { covered, clip } = buildClip(b.width, b.height, hole);
  if (covered) {
    log('[disp] hide (covered by window)');
    sendFgHole(null);
    if (win.isVisible()) win.hide();
    return;
  }
  if (!win.isVisible()) { log('[disp] show (partial overlap)'); win.showInactive(); }
  log('[disp] hole ' + JSON.stringify(hole));
  sendFgHole({ hole, clip });
}

// перезапуск часов: прямой detached-спавн нового экземпляра electron с --clock
function restartClockNow() {
  quitting = true;
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [__dirname, '--clock'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (e) => log('restart spawn error: ' + (e.stack || e.message)));
  child.unref();
  app.quit();
}

// меню прозрачности/фиксации — общее для трея и ПКМ
function buildUiMenu() {
  const ui = loadUi();
  return Menu.buildFromTemplate([
    { label: 'Показать/скрыть часы', click: toggleWin },
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
    { label: 'Перезапустить часы', click: restartClockNow },
    { label: 'Закрыть часы', click: () => { quitting = true; app.quit(); } },
  ]);
}

function toggleWin() {
  if (!win || win.isDestroyed()) {
    createWindow();
    applyDisplayMode();
    return;
  }
  if (win.isVisible()) {
    userHidden = true; // сам скрыл — автопоказ режима не перебивает
    win.hide();
  } else {
    userHidden = false;
    win.show();
  }
}

// ---------------- окно ----------------

function createWindow() {
  const bounds = loadBounds();
  win = new BrowserWindow({
    width: 180,
    height: 70,
    useContentSize: true,
    ...(bounds || {}),
    minWidth: 120,
    minHeight: 56,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    focusable: false, // клик по часам не делает их активным окном — рабочий стол остаётся активным
    title: 'Часы',
    webPreferences: {
      preload: path.join(__dirname, 'preload-clock.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile('clock.html');
  // границы запоминаем debounce'ом (важно при жёстком рестарте)
  let timer = null;
  const saveSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(saveBounds, 500);
  };
  win.on('resize', saveSoon);
  win.on('move', saveSoon);
  win.on('close', saveBounds);
  // часы переехали — «дырка» под окном двигается вместе с ними плавно,
  // поэтому пересчёт на каждом событии, без дебаунса
  win.on('move', applyDisplayMode);
  win.on('resize', applyDisplayMode);
  win.applyUi = (ui) => {
    if (win.isDestroyed()) return;
    win.setResizable(!ui.locked); // с ручным перетаскиванием movable не участвует
  };
  win.applyUi(loadUi());
  win.webContents.on('did-finish-load', () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('yp:ui', loadUi());
      // актуальные режим стол/окна и «дырка» (события могли прийти до загрузки)
      win.webContents.send('yp:fgmode', fgNow);
      sendFgHole(lastHole);
    }
  });
}

// ---------------- IPC ----------------

ipcMain.handle('ui:getUi', () => loadUi());
ipcMain.handle('ui:ignoreMouse', (_e, v) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!v, { forward: true });
});
// пункты меню часов для popup-окна
function buildClockMenuItems(ui) {
  return [
    { id: 'toggle', label: 'Показать/скрыть часы' },
    { type: 'sep' },
    {
      id: 'opacity',
      label: 'Прозрачность фона',
      items: OPACITIES.map((v) => ({
        id: 'opacity-' + v,
        label: v >= 100 ? 'Непрозрачный (100%)' : v === 0 ? 'Полностью прозрачный (0%)' : `Дымка ${v}%`,
        checked: ui.opacity === v,
      })),
    },
    { id: 'display-desktop', label: 'Только рабочий стол', checked: ui.display === 'desktop' },
    { id: 'lock', label: 'Зафиксировать положение', checked: !!ui.locked },
    { type: 'sep' },
    { id: 'restart', label: 'Перезапустить часы' },
    { id: 'close', label: 'Закрыть часы' },
  ];
}

// ПКМ по часам — popup-меню у курсора (закрывается любым кликом снаружи)
ipcMain.handle('ymc:ctxmenu', (_e, pt) => {
  if (!win || win.isDestroyed()) return;
  menuOpen = true; // пока меню открыто, в режиме «desktop» не прятать
  openMenuPopup({
    x: pt && pt.x,
    y: pt && pt.y,
    payload: { items: buildClockMenuItems(loadUi()) },
    onPick: (id) => {
      if (id === 'toggle') return toggleWin();
      if (id === 'lock') return applyUi({ locked: !loadUi().locked });
      if (id === 'display-desktop') {
        return applyUi({ display: loadUi().display === 'desktop' ? 'top' : 'desktop' });
      }
      if (id === 'restart') return restartClockNow();
      if (id === 'close') {
        quitting = true;
        app.quit();
        return;
      }
      const m = /^opacity-(\d+)$/.exec(id);
      if (m) return applyUi({ opacity: Number(m[1]) });
    },
    onClose: () => {
      menuOpen = false;
      // FG-смотритель узнаёт о возврате фокуса рабочему столу до 400 мс —
      // перепроверяем видимость чуть позже, чтобы не мигнуть зря
      setTimeout(applyDisplayMode, 450);
    },
  });
});
// ручное перетаскивание (drag-area глотает правый клик, поэтому двигаем сами)
ipcMain.on('ymc:moveTo', (_e, x, y) => {
  if (!win || win.isDestroyed()) return;
  if (loadUi().locked) return; // зафиксировано — не двигаем
  const nx = Math.round(Number(x));
  const ny = Math.round(Number(y));
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    log(`moveTo REJECTED: x=${x} y=${y}`);
    return;
  }
  win.setPosition(nx, ny, false);
});
ipcMain.handle('ymc:getPositions', () => {
  if (!win || win.isDestroyed()) return null;
  return win.getPosition();
});
// отладка из renderer
ipcMain.on('ymc:log', (_e, msg) => log('renderer: ' + msg));

// ---------------- рантайм ----------------

nativeTheme.themeSource = 'dark';

app.whenReady().then(() => {
  createWindow();
  applyDisplayMode(); // при «только рабочий стол» стартуем скрытым, если окно перекрывает
  // трей часов (та же иконка)
  tray = new Tray(path.join(__dirname, 'icon.ico'));
  tray.setToolTip('Часы · виджет');
  tray.setContextMenu(buildUiMenu());
  tray.on('click', toggleWin);
  // рабочий стол vs другие окна — управление click-through и «дыркой»
  // (окна самих часов — popup-меню — считаем рабочим столом)
  const fg = new ForegroundWatcher((info) => {
    fgNow = info.mode === 'desktop' ? 'desktop' : 'window';
    fgRect = info.mode === 'window' && [info.x, info.y, info.w, info.h].every(Number.isFinite)
      ? { x: info.x, y: info.y, w: info.w, h: info.h }
      : null;
    if (win && !win.isDestroyed()) win.webContents.send('yp:fgmode', fgNow);
    applyDisplayMode();
  }, process.pid);
  fg.start();
});

app.on('before-quit', () => {
  saveBounds();
  quitting = true;
});

app.on('window-all-closed', () => {
  app.quit();
});
