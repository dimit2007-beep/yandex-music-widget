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
let fgNow = 'window';   // что сейчас активно (от ForegroundWatcher) — для клик-сквози
let userHidden = false; // пользователь сам скрыл часы

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

// «Только рабочий стол»: часы живут в общем слое окон, как виджет рабочего
// стола: видны над обоями, а любое наехавшее окно — активное или нет —
// накрывает их штатно, силами самой Windows (плавно и точно, без «дырок»)
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
  if (!win.isVisible()) { log('[disp] show (mode=' + mode + ')'); win.showInactive(); }
}

// поднять окно наверх его зоны (трюк «topmost -> не-topmost», moveTop для
// нашего окна не работает — проверено тестом)
function raiseWindow() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  if (displayMode === 'desktop' && !userHidden) win.setAlwaysOnTop(false);
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
    applyDisplayMode();
    raiseWindow(); // подняться над соседними в общем слое (режим «desktop»)
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
  win.applyUi = (ui) => {
    if (win.isDestroyed()) return;
    win.setResizable(!ui.locked); // с ручным перетаскиванием movable не участвует
  };
  win.applyUi(loadUi());
  win.webContents.on('did-finish-load', () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('yp:ui', loadUi());
      // актуальный режим стол/окна (событие могло прийти до загрузки страницы)
      win.webContents.send('yp:fgmode', fgNow);
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
    onClose: () => {},
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
// взятись за часы — подняться над соседними в общем слое окон (режим «desktop»)
ipcMain.handle('ymc:raise', () => {
  if (win && !win.isDestroyed()) raiseWindow();
});
// отладка из renderer
ipcMain.on('ymc:log', (_e, msg) => log('renderer: ' + msg));

// ---------------- рантайм ----------------

nativeTheme.themeSource = 'dark';

app.whenReady().then(() => {
  createWindow();
  applyDisplayMode(); // применить сохранённый режим показа (top/desktop)
  // трей часов (та же иконка)
  tray = new Tray(path.join(__dirname, 'icon.ico'));
  tray.setToolTip('Часы · виджет');
  tray.setContextMenu(buildUiMenu());
  tray.on('click', toggleWin);
  // рабочий стол vs другие окна — управление клик-сквозью
  // (окна самих часов — popup-меню — считаем рабочим столом)
  const fg = new ForegroundWatcher((info) => {
    fgNow = info.mode === 'desktop' ? 'desktop' : 'window';
    if (win && !win.isDestroyed()) win.webContents.send('yp:fgmode', fgNow);
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
