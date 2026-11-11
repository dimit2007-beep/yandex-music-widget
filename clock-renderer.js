/* Часы: время + клик-сквозь + ручное перетаскивание + ПКМ-меню. */

const $ = (id) => document.getElementById(id);
const timeEl = $('time');

// ------- время -------
function tick() {
  const d = new Date();
  timeEl.textContent =
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
tick();
setTimeout(() => { tick(); }, 1000 - (Date.now() % 1000));
setInterval(tick, 1000);

// ------- вид: прозрачность/фиксация -------
let locked = false;
function applyUi(u) {
  const o = u.opacity == null ? 25 : u.opacity;
  const plate = $('plate');
  plate.style.background = `rgba(14, 14, 18, ${o / 100})`;
  const blur = o === 0 ? 0 : o < 15 ? 2 : o < 35 ? 4 : 6;
  plate.style.backdropFilter = blur ? `blur(${blur}px)` : 'none';
  locked = !!u.locked;
  document.body.classList.toggle('locked', locked);
}

window.ymc.onUi(applyUi);
window.ymc.uiState().then(applyUi).catch(() => {});

// ------- ручное перетаскивание (левая кнопка) -------
// drag-area не используем: на «drag» областях Windows глотает правый клик,
// а нам нужно и таскать, и открывать меню.
let drag = null; // { startMouseX, startMouseY, winX, winY }

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || locked) return;
  window.ymc.getPositions().then((pos) => {
    if (!pos || pos.length < 2) return;
    const [px, py] = pos;
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    drag = {
      startMouseX: e.screenX,
      startMouseY: e.screenY,
      winX: px,
      winY: py,
    };
  }).catch((err) => window.ymc.log('getPositions ERR ' + err));
});

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  if (e.buttons !== 1 || locked) {
    if (e.buttons !== 1) drag = null; // отпустили
    return;
  }
  if (!Number.isFinite(e.screenX) || !Number.isFinite(e.screenY)) return;
  window.ymc.moveTo(
    drag.winX + (e.screenX - drag.startMouseX),
    drag.winY + (e.screenY - drag.startMouseY)
  );
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    drag = null;
    updateIgnore(); // применяем клик-сквозь, отложенный на время жеста
  }
});

// ПКМ по часам: меню у курсора
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.ymc.ctxMenu({ x: e.screenX, y: e.screenY });
});

// ------- клик-сквозь: рабочий стол = интерактив, приложения = сквозь -------
let fgMode = 'window';
let ignoreMouse = null;

window.ymc.onFgMode((mode) => {
  fgMode = mode;
  updateIgnore();
});

function updateIgnore() {
  // во время перетаскивания не включаем клик-сквозь — иначе жест рвётся
  if (drag) return;
  // у часов нет интерактивных элементов: интерактивен только рабочий стол
  const should = fgMode === 'desktop' ? false : true;
  if (should !== ignoreMouse) {
    ignoreMouse = should;
    window.ymc.ignoreMouse(should);
  }
}

window.addEventListener('mouseout', () => updateIgnore());
