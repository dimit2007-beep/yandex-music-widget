/**
 * Контекстные меню виджетов: собственное popup-окно.
 * Нативные Menu.popup на нефокусируемых окнах не захватывают клики и не
 * закрываются кликом в сторону — это окно, наоборот, фокусируемое,
 * поэтому меню закрывается ЛЮБЫМ кликом вне его (blur) и Esc.
 * Меню может выходить за границы плашки: это отдельное окно.
 */
const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

let popup = null; // окно меню
let cur = null; // { onPick }

// каналы слушаем один раз
ipcMain.handle('menu:pick', (e, id) => {
  if (popup && e.sender === popup.webContents) {
    // ВАЖНО: close() обнуляет cur — берём callback ДО закрытия
    const cb = cur && cur.onPick;
    close();
    if (cb) cb(id);
  }
  return true;
});

ipcMain.handle('menu:close', (e) => {
  if (popup && e.sender === popup.webContents) close();
  return true;
});

ipcMain.on('menu:log', (_e, msg) => console.log('[menu] ' + msg));

// клик-сквозь прозрачных полей окна меню (управляет renderer по координатам мыши)
ipcMain.on('menu:ignore', (e, v) => {
  if (popup && !popup.isDestroyed() && e.sender === popup.webContents) {
    popup.setIgnoreMouseEvents(!!v, { forward: true });
  }
});

ipcMain.on('menu:ready', (e, size) => {
  if (!popup || e.sender !== popup.webContents || !cur) return;
  // renderer раскладывает меню и окно ОДИН раз (окно с запасом под подменю и
  // БОЛЬШЕ НЕ ДВИГАЕТСЯ — прыжков при открытии подменю нет в принципе)
  console.log('[menu] ready ' + Math.round(size.w) + 'x' + Math.round(size.h) + ' at ' + Math.round(size.x) + ',' + Math.round(size.y));
  popup.setBounds({
    x: Math.round(size.x),
    y: Math.round(size.y),
    width: Math.ceil(size.w),
    height: Math.ceil(size.h),
  });
  popup.show();
  popup.focus();
  // ВНИМАНИЕ: не вызывать здесь capturePage() — он сбрасывает фокус окна
  // (экспериментально подтверждено: blur приходил ровно на 800-мс таймере диагностики)
});

function close() {
  if (!popup) return;
  const p = popup;
  const cb = cur && cur.onClose; // уведомить владельца меню (режим показа и т.п.)
  popup = null;
  cur = null;
  try { p.close(); } catch (_) {}
  if (cb) { try { cb(); } catch (_) {} }
}

function estimateSize(payload) {
  // прикидка размера до замера renderer'ом (некритично, уточним после load)
  let maxLen = 0, rows = 0, seps = 0;
  const walk = (items) => {
    for (const it of items) {
      if (it.type === 'sep') { seps++; continue; }
      rows++;
      if (it.label && it.label.length > maxLen) maxLen = it.label.length;
      if (it.items) walk(it.items);
    }
  };
  walk(payload.items || []);
  const width = Math.min(340, Math.max(240, 26 + maxLen * 9));
  const height = 10 + rows * 29 + seps * 11;
  return { width, height };
}

function openMenuPopup({ x, y, payload, onPick, onClose }) {
  close(); // прежнее меню убрать
  cur = { x: Math.round(x), y: Math.round(y), onPick, onClose };
  const est = estimateSize(payload);
  // параметры popup'а — максимально близко к плашкам (они рисуют текст нормально)
  popup = new BrowserWindow({
    show: false, // показываем только после точной раскладки из menu:ready
    x: cur.x,
    y: cur.y,
    ...est,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-menu.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // окно скрыто до ready — кадры не тормозить
    },
  });

  // (удалён DEBUG RED TEXT TEST — его задача «проверить рендер новых окон» выполнена)
  popup.setAlwaysOnTop(true, 'screen-saver');
  popup.on('blur', () => {
    // клик в сторону — меню закрыто. Но первый blur бывает ложным (фокус
    // возвращается сам) — проверяем состояние через 150мс перед закрытием.
    setTimeout(() => {
      if (popup && !popup.isDestroyed()) {
        if (!popup.isFocused()) {
          close();
        }
      }
    }, 150);
  }); // клик в сторону — меню закрыто (одним кликом!)
  popup.on('closed', () => {
    popup = null;
    cur = null;
  });
  popup.loadFile(path.join(__dirname, 'menu-popup.html'));
  popup.webContents.on('did-finish-load', () => {
    if (popup && !popup.isDestroyed()) {
      // anchor — куда должно встать меню (позиция курсора): renderer сам
      // рассчитает окно с запасом под подменю и пришлёт готовый размер
      popup.webContents.send('menu:init', { items: payload.items, anchor: { x: cur.x, y: cur.y } });
      // без этого строки меню дорисовываются только по мере инвалидации
      try { popup.webContents.invalidate(); } catch (_) {}
    }
  });
  popup.webContents.on('render-process-gone', (_e, d) => console.error('[menu] renderer-gone: ' + d.reason + ' exit=' + d.exitCode));
}

module.exports = { openMenuPopup, closeMenuPopup: close };
