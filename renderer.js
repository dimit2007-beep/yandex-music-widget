/* Логика плашки: приём состояния, локальная интерполяция прогресса, кнопки. */

const $ = (id) => document.getElementById(id);
const els = {
  auth: $('auth-view'),
  player: $('player'),
  cover: $('cover'),
  title: $('title'),
  artist: $('artist'),
  fill: $('fill'),
  time: $('time'),
  like: $('btn-like'),
  prev: $('btn-prev'),
  play: $('btn-play'),
  icPlay: $('ic-play'),
  icPause: $('ic-pause'),
  next: $('btn-next'),
  login: $('btn-login'),
};

let state = null; // последнее состояние от главного процесса
let coverShown = null; // URL обложки, применённый к <img> последним
let authorized = false;

// ------- таймер прогресса: монотонные часы -------
// Сэмплы состояния приходят раз в ~2 c, а позиция в них квантована до целых
// секунд (слайдер в DOM приложения целочисленный). Если каждый сэмпл делать
// новым якорем, таймер каждые ~2 c откатывается назад на долю секунды —
// «дёргается». Поэтому позиция — часы, которые тикают сами между сэмплами
// (posMs + прошедшее время от якоря), а якорь переприменяется только при
// РЕАЛЬНОМ сдвиге: перемотка, смена трека, первый сэмпл. Мелкие расхождения
// сэмпла с нашими часами (шум квантования ±1 c) игнорируем.
let posMs = 0;      // опорная позиция, мс
let posAt = 0;      // Date.now() опорной позиции; 0 = пауза (не тикаем)
let anchored = false;
let lastTitle = null;

function interpolatedPos(now) {
  return posAt ? posMs + (now - posAt) : posMs;
}

// применить якорь из нового состояния
function applyAnchor(s) {
  const now = Date.now();
  if (!s.title) {
    posMs = 0; posAt = 0; anchored = false; lastTitle = null; // «тишина» — в ноль
    return;
  }
  const speed = s.playbackSpeed || 1;
  // сэмпл снят в момент receivedAt; пока шли обогащающие запросы, трек играл
  const at = s.receivedAt || now;
  const a = Math.max(0, (s.progressMs || 0) + (s.paused ? 0 : (now - at) * speed));
  if (s.paused) {
    // пауза: застываем на позиции сэмпла. Повторные сэмплы на паузе дают одно
    // и то же значение (позиция заморожена), так что снап не дёргает; зато
    // перемотка на паузе видна сразу и после возобновления часы не «забегают»
    posMs = a;
    posAt = 0;
    anchored = true;
    lastTitle = s.title;
    return;
  }
  const cur = interpolatedPos(now);
  // шум квантования (позиция приходит целыми секундами) даёт расхождение
  // в пределах ±1 c и меняется от сэмпла к сэмплу — его игнорируем. Устойчивый
  // сдвиг больше ~1.2 c означает реальное событие: перемотку, буферизацию,
  // конец трека. Так дисплей движется монотонно, без пилы каждые 2 c.
  const o = a - cur;
  const seek = !anchored || s.title !== lastTitle || Math.abs(o) > 1200;
  if (seek) {
    posMs = a;
    posAt = now;
    anchored = true;
  } else if (!posAt) {
    posAt = now; // возобновили после паузы — тикаем с той же позиции
  }
  lastTitle = s.title;
}

// показ: интерполяция каждые 250 мс между сэмплами состояния
setInterval(() => {
  if (!state) return;
  renderProgress(state.paused ? posMs : interpolatedPos(Date.now()));
}, 250);

function renderProgress(progressMs) {
  const d = state ? state.durationMs : 0;
  const p = d ? Math.min(progressMs, d) : progressMs; // у конца не выпадать за длительность
  const pct = d ? (100 * p) / d : 0;
  els.fill.style.width = pct.toFixed(2) + '%';
  els.time.textContent = fmt(p) + ' / ' + fmt(d);
}

function fmt(ms) {
  ms = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(ms / 60);
  const s = ms % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function renderState(s) {
  if (s.title) {
    els.title.textContent = s.title;
    els.title.title = s.title + (s.album ? ' · ' + s.album : '');
  } else {
    els.title.textContent = '—';
    els.title.title = '';
  }
  els.artist.textContent = s.artists || 'Пока тишина…';
  if (s.cover) {
    // сравниваем ПОЛНЫЙ URL: последний сегмент у всех обложек ЯМ —
    // размер («400x400»), по нему смена не определялась и картинка залипала
    if (coverShown !== s.cover) {
      els.cover.src = s.cover; // обновляем только при смене обложки (иначе перезапрос)
      coverShown = s.cover;
    }
    els.cover.style.visibility = 'visible';
  } else {
    // нет данных об обложке в этом состоянии — не показываем чужую устаревшую
    els.cover.removeAttribute('src');
    coverShown = null;
    els.cover.style.visibility = 'hidden';
  }
  els.like.classList.toggle('liked', !!s.liked);
  // ВАЖНО: ic-play/ic-pause — это <svg> (SVGElement), у него НЕТ свойства
  // .hidden — присваивание молча ничего не делает. Переключаем атрибут.
  els.icPlay.toggleAttribute('hidden', !s.paused);
  els.icPause.toggleAttribute('hidden', !!s.paused);
}

// ------- события из главного процесса -------

window.ym.onState((s) => {
  state = s;
  applyAnchor(s); // часы: применить якорь (со сдвигом только при реальном событии)
  renderState(s);
  renderProgress(s.paused ? posMs : interpolatedPos(Date.now()));
});

window.ym.onAuth((a) => {
  authorized = !!a.ok;
  els.auth.hidden = authorized;
  els.player.hidden = !authorized;
});

// ------- кнопки -------

els.play.addEventListener('click', () => state && (state.paused ? window.ym.play() : window.ym.pause()));
els.next.addEventListener('click', () => window.ym.next());
els.prev.addEventListener('click', () => window.ym.prev());
els.like.addEventListener('click', async () => {
  if (!state) return;
  const target = !state.liked;
  els.like.classList.toggle('liked', target); // оптимистичный отклик
  // CDP-источник: жмём настоящую кнопку «Нравится» в приложении ЯМ (ID не нужен)
  if (state.source === 'cdp') {
    await window.ym.setLike(null, target);
    return;
  }
  if (!state.trackId) return;
  const ok = await window.ym.setLike(state.trackId, target);
  if (ok && state) state.liked = target;
  else els.like.classList.toggle('liked', !target); // откат, если сорвалось
});
els.login.addEventListener('click', () => window.ym.login());

// ПКМ по виджету: popup-меню у курсора
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.ym.openMenu(e.screenX, e.screenY);
});

// старт
window.ym.authState().then((a) => {
  authorized = !!a.ok;
  els.auth.hidden = authorized;
  els.player.hidden = !authorized;
});

// ------- клик-сквозь: рабочий стол = интерактив, приложения = сквозь (кроме кнопок) -------

let fgMode = 'window';
let lastMouse = { x: -1, y: -1 };
let ignoreMouse = null; // текущее посланное состояние

window.ym.onFgMode((mode) => {
  fgMode = mode;
  updateIgnore(hoveredInteractive(lastMouse.x, lastMouse.y));
  document.body.dataset.fgmode = mode;
});

function hoveredInteractive(x, y) {
  if (!fgMode) return false;
  if (fgMode === 'desktop') return true;
  // активно приложение: интерактивны только кнопки (и кнопка входа),
  // остальная плашка пропускает клики окну под виджетом
  const el = document.elementFromPoint(x, y);
  return !!el && !!el.closest('button, #btn-login');
}

function updateIgnore(hover) {
  if (drag) return; // не переключать во время собственного перетаскивания
  // desktop: интерактивно всё; window: сквозь всё, кроме кнопок под курсором
  const should = fgMode === 'desktop' ? false : !hover;
  if (should !== ignoreMouse) {
    ignoreMouse = should;
    window.ym.ignoreMouse(should);
  }
}

window.addEventListener('mousemove', (e) => {
  lastMouse = { x: e.clientX, y: e.clientY };
  updateIgnore(hoveredInteractive(e.clientX, e.clientY));
});
window.addEventListener('mouseout', (e) => {
  if (e.relatedTarget) return; // переход между элементами внутри — не уход
  lastMouse = { x: -1, y: -1 };
  updateIgnore(false);
});

// ------- вид: прозрачность фона и показ кнопок (управляется из трея) -------

function applyUi(u) {
  const o = u.opacity == null ? 25 : u.opacity;
  document.getElementById('widget').style.background = `rgba(14, 14, 18, ${o / 100})`;
  const blur = o === 0 ? 0 : o < 15 ? 2 : o < 35 ? 4 : 6; // чем прозрачнее, тем меньше блюр
  document.getElementById('widget').style.backdropFilter = blur ? `blur(${blur}px)` : 'none';
  document.body.classList.toggle('no-buttons', u.buttons === false);
  document.body.classList.toggle('locked', !!u.locked);
  uiLocked = !!u.locked;
}

// ------- ручное перетаскивание (drag-области глотали ПКМ, показывали системное меню) -------

let uiLocked = false;
let drag = null; // { startMouseX, startMouseY, winX, winY }

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || uiLocked) return;
  // кнопки плеера и кнопка входа — не драг (там клики)
  if (e.target.closest('button, #btn-login')) return;
  // как у обычного окна: взятись — подняться над соседними в общем слое
  window.ym.raise();
  window.ym.getPosition().then((pos) => {
    if (!pos || pos.length < 2) return;
    const [px, py] = pos;
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    drag = { startMouseX: e.screenX, startMouseY: e.screenY, winX: px, winY: py };
  }).catch(() => {});
});

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  if (e.buttons !== 1 || uiLocked) {
    drag = null;
    return;
  }
  if (!Number.isFinite(e.screenX) || !Number.isFinite(e.screenY)) return;
  window.ym.moveTo(
    drag.winX + (e.screenX - drag.startMouseX),
    drag.winY + (e.screenY - drag.startMouseY)
  );
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) drag = null;
});

window.ym.onUi(applyUi);
window.ym.uiState().then(applyUi).catch(() => {});

// кнопка не должна оставаться «нажатой» (иначе Chromium рисует фокус-подсветку)
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) b.blur();
});

