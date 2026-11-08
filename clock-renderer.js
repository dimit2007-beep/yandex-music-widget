/* Часы: время + клик-сквозь + настройки вида из main. */

const $ = (id) => document.getElementById(id);
const timeEl = $('time');

// ------- время -------
function tick() {
  const d = new Date();
  timeEl.textContent =
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
setTimeout(() => { tick(); setInterval(tick, 1000); }, 400); // старт после выравнивания по секунде не критичен
tick();
setInterval(tick, 1000);

// ------- вид: прозрачность/фиксация -------
function applyUi(u) {
  const o = u.opacity == null ? 25 : u.opacity;
  const plate = $('plate');
  plate.style.background = `rgba(14, 14, 18, ${o / 100})`;
  const blur = o === 0 ? 0 : o < 15 ? 2 : o < 35 ? 4 : 6;
  plate.style.backdropFilter = blur ? `blur(${blur}px)` : 'none';
  document.body.classList.toggle('locked', !!u.locked);
}

window.ymc.onUi(applyUi);
window.ymc.uiState().then(applyUi).catch(() => {});

// ------- клик-сквозь: рабочий стол = интерактив, приложения = сквозь -------
let fgMode = 'window';
let ignoreMouse = null;

window.ymc.onFgMode((mode) => {
  fgMode = mode;
  updateIgnore();
});

function updateIgnore() {
  // у часов нет интерактивных элементов: интерактивен только рабочий стол
  const should = fgMode === 'desktop' ? false : true;
  if (should !== ignoreMouse) {
    ignoreMouse = should;
    window.ymc.ignoreMouse(should);
  }
}

window.addEventListener('mouseout', () => updateIgnore());
window.addEventListener('mousemove', () => updateIgnore());
