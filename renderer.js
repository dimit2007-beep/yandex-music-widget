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
let authorized = false;

// плавный прогресс между обновлениями Ynison
setInterval(() => {
  if (!state || state.paused || !state.durationMs) return;
  const speed = state.playbackSpeed || 1;
  const elapsed = Date.now() - state.receivedAt;
  const p = state.progressMs + elapsed * speed;
  renderProgress(Math.min(p, state.durationMs));
}, 500);

function renderProgress(progressMs) {
  const d = state ? state.durationMs : 0;
  const pct = d ? (100 * progressMs) / d : 0;
  els.fill.style.width = pct.toFixed(2) + '%';
  els.time.textContent = fmt(progressMs) + ' / ' + fmt(d);
}

function fmt(ms) {
  ms = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(ms / 60);
  const s = ms % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function renderState(s) {
  state = s;
  if (s.title) {
    els.title.textContent = s.title;
    els.title.title = s.title + (s.album ? ' · ' + s.album : '');
  } else {
    els.title.textContent = '—';
    els.title.title = '';
  }
  els.artist.textContent = s.artists || 'Пока тишина…';
  if (s.cover) {
    if (!els.cover.src || !els.cover.src.endsWith(s.cover.split('/').pop())) {
      els.cover.src = s.cover; // обновляем только при смене трека
    }
    els.cover.style.visibility = 'visible';
  } else {
    // нет данных об обложке в этом состоянии — не показываем чужую устаревшую
    els.cover.removeAttribute('src');
    els.cover.style.visibility = 'hidden';
  }
  els.like.classList.toggle('liked', !!s.liked);
  // ВАЖНО: ic-play/ic-pause — это <svg> (SVGElement), у него НЕТ свойства
  // .hidden — присваивание молча ничего не делает. Переключаем атрибут.
  els.icPlay.toggleAttribute('hidden', !s.paused);
  els.icPause.toggleAttribute('hidden', !!s.paused);
  els.time.textContent = fmt(s.progressMs) + ' / ' + fmt(s.durationMs);
}

// ------- события из главного процесса -------

window.ym.onState((s) => {
  renderState(s);
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

// ------- клик-сквозь: рабочий стол = интерактив, другие окна = сквозь (кроме кнопок) -------

let fgMode = 'window';
let ignoreMouse = null; // текущее посланное состояние

const HOVER_SELECTOR = 'button, #btn-login'; // наведение на эти элементы пробуждает виджет

window.ym.onFgMode((mode) => {
  fgMode = mode;
  updateIgnore();
  document.body.dataset.fgmode = mode;
});

function hoveredInteractive(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return false;
  if (!fgMode) return false;
  return !!el.closest('button, #btn-login');
}

function updateIgnore(hover) {
  // desktop: интерактивно всё; window: сквозь всё, кроме наведения на кнопки
  const should = fgMode === 'desktop' ? false : !hover;
  if (should !== ignoreMouse) {
    ignoreMouse = should;
    window.ym.ignoreMouse(should);
  }
}

window.addEventListener('mousemove', (e) => {
  updateIgnore(hoveredInteractive(e.clientX, e.clientY));
});
window.addEventListener('mouseout', () => updateIgnore(false));

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

