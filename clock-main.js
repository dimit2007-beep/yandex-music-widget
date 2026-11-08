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
const path = require('path');
const fs = require('fs');
const { ForegroundWatcher } = require('./foreground');

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

const DEFAULT_UI = { opacity: 25, locked: false };
const OPACITIES = [0, 5, 10, 25, 40, 60, 80, 100];

let win = null;
let tray = null;
let quitting = false;

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
  if (tray) tray.setContextMenu(buildUiMenu());
  if (win && win.applyUi) win.applyUi(ui);
  if (win && !win.isDestroyed()) win.webContents.send('yp:ui', ui);
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
      label: 'Зафиксировать положение',
      type: 'checkbox',
      checked: !!ui.locked,
      click: () => applyUi({ locked: !loadUi().locked }),
    },
    { type: 'separator' },
    { label: 'Закрыть часы', click: () => { quitting = true; app.quit(); } },
  ]);
}

function toggleWin() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isVisible()) win.hide();
  else win.show();
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
    if (win && !win.isDestroyed()) win.webContents.send('yp:ui', loadUi());
  });
}

// ---------------- IPC ----------------

ipcMain.handle('ui:getUi', () => loadUi());
ipcMain.handle('ui:ignoreMouse', (_e, v) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!v, { forward: true });
});
// ПКМ по часам: меню у курсора (окно без drag-областей, поэтому событие доходит)
ipcMain.handle('ymc:ctxmenu', () => {
  if (!win || win.isDestroyed()) return;
  buildUiMenu().popup({ window: win });
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
  // трей часов (та же иконка)
  tray = new Tray(path.join(__dirname, 'icon.ico'));
  tray.setToolTip('Часы · виджет');
  tray.setContextMenu(buildUiMenu());
  tray.on('click', toggleWin);
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

app.on('window-all-closed', () => {
  app.quit();
});
