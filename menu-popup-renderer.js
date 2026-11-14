/* Контекстное меню в popup-окне: строит пункты, шлёт выбранный id.
   Архитектура «неподвижного окна»: окно сразу раскладывается с запасом под
   подменю слева и справа и БОЛЬШЕ не двигается и не меняет размер — прыжков
   при открытии подменю нет в принципе. Подменю открывается чистым CSS вправо
   или влево. Прозрачные поля окна пропускают клики (setIgnoreMouseEvents +
   forward), наведение отслеживается по координатам мыши (elementFromPoint). */

const menuEl = document.getElementById('menu');
const SUB_GAP = 6; // зазор между меню и подменю

let anchor = { x: 0, y: 0 }; // куда встаёт меню (экранные DIP, считает main)
let layout = null; // { leftM, rightM, menuW, winH }

function buildItems(items, into, isTop) {
  into.innerHTML = '';
  for (const it of items) {
    if (it.type === 'sep') {
      const s = document.createElement('div');
      s.className = 'msep';
      into.appendChild(s);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'mi' + (it.checked ? ' checked' : '') + (it.items ? ' has-sub' : '');
    const check = document.createElement('span');
    check.className = 'check';
    check.textContent = '\u2713';
    row.appendChild(check);
    const label = document.createElement('span');
    label.textContent = it.label;
    row.appendChild(label);
    if (it.items) {
      const arr = document.createElement('span');
      arr.className = 'arr';
      arr.textContent = '\u25B8';
      row.appendChild(arr);
      const sub = document.createElement('div');
      sub.className = 'msub';
      row.appendChild(sub);
      buildItems(it.items, sub, false);
      row.addEventListener('mouseenter', () => openSub(row, sub));
    } else if (isTop) {
      // наведение на обычный пункт закрывает чужое подменю
      row.addEventListener('mouseenter', () => closeAllSubs());
      row.addEventListener('click', () => window.mnu.pick(it.id));
    } else {
      row.addEventListener('click', () => window.mnu.pick(it.id));
    }
    into.appendChild(row);
  }
}

function closeAllSubs() {
  let closed = false;
  menuEl.querySelectorAll('.msub.open').forEach((s) => {
    s.classList.remove('open');
    closed = true;
  });
  return closed;
}

// измерить все подменю (display:none → временно показать невидимо)
function measureSubs() {
  const subs = Array.from(menuEl.querySelectorAll('.msub'));
  subs.forEach((s) => { s.style.display = 'block'; s.style.visibility = 'hidden'; });
  const res = { maxSub: 0, maxDrop: 0 };
  for (const s of subs) {
    const row = s.parentElement;
    res.maxSub = Math.max(res.maxSub, s.offsetWidth);
    res.maxDrop = Math.max(res.maxDrop, row.offsetTop + s.offsetHeight + 6);
  }
  subs.forEach((s) => { s.style.display = ''; s.style.visibility = ''; });
  return res;
}

// ОДИН раз раскладываем окно: меню встаёт в anchor, окно получает запас под
// подменю по обе стороны (сколько есть на экране). Дальше окно не трогаем.
function layoutWindow() {
  const { maxSub, maxDrop } = measureSubs();
  const mw = menuEl.offsetWidth;
  const mh = menuEl.offsetHeight;
  const scr = window.screen;
  const availL = scr.availLeft;
  const availR = scr.availLeft + scr.availWidth;
  const availB = scr.availTop + scr.availHeight;
  // меню целиком в пределах экрана
  const mx = Math.max(availL, Math.min(anchor.x, availR - mw));
  const my = Math.max(scr.availTop, Math.min(anchor.y, availB - mh));
  // запасы под подменю слева/справа — ровно столько, сколько позволяет экран
  let leftM = Math.min(maxSub + SUB_GAP + 2, mx - availL);
  let rightM = Math.min(maxSub + SUB_GAP + 2, availR - (mx + mw));
  if (leftM < 0) leftM = 0;
  if (rightM < 0) rightM = 0;
  menuEl.style.position = 'absolute';
  menuEl.style.left = leftM + 'px';
  menuEl.style.top = '0px';
  const winW = leftM + mw + rightM;
  const winH = Math.min(Math.max(mh, maxDrop), availB - my);
  layout = { leftM, rightM, menuW: mw, winH };
  window.mnu.ready({ x: Math.round(mx - leftM), y: Math.round(my), w: winW, h: winH });
}

// открыть подменю у строки: вправо, если в окне есть запас, иначе влево.
// #menu теперь position:absolute — подменю позиционируется ОТ МЕНЮ.
// Мост 4px: подменю заходит на меню, иначе в щели мышь ловит уход с меню
// и подменю схлопывается.
function openSub(row, sub) {
  menuEl.querySelectorAll('.msub.open').forEach((x) => {
    if (x !== sub) x.classList.remove('open');
  });
  sub.classList.add('open');
  const sw = sub.offsetWidth;
  if (layout && layout.rightM >= sw + 2) {
    sub.style.left = layout.menuW - 4 + 'px'; // вправо
  } else if (layout && layout.leftM >= sw + 2) {
    sub.style.left = -(sw - 4) + 'px'; // влево
  } else {
    sub.style.left = '4px'; // совсем нет места — поверх меню
  }
  let top = row.offsetTop - 6;
  const sh = sub.offsetHeight;
  if (layout && top + sh > layout.winH) top = Math.max(0, layout.winH - sh - 6);
  sub.style.top = top + 'px';
}

// ------- клик-сквозь прозрачных полей + закрытие подменю по уходу мыши -------

function overMenu(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return false;
  if (menuEl.contains(el)) return true;
  for (const s of menuEl.querySelectorAll('.msub.open')) {
    if (s.contains(el)) return true;
  }
  return false;
}

let ignoring = false;
function setIgnore(v) {
  if (v !== ignoring) {
    ignoring = v;
    window.mnu.ignoreMouse(v);
  }
}

window.addEventListener('mousemove', (e) => {
  const over = overMenu(e.clientX, e.clientY);
  setIgnore(!over);
  if (!over) closeAllSubs(); // ушли с меню — подменю закрыть
});

window.addEventListener('mouseout', (e) => {
  if (e.relatedTarget) return; // переход между элементами внутри — не уход
  setIgnore(true);
  closeAllSubs();
});

// страховка: реальный клик в прозрачном поле, пока пропуск ещё не включился
window.addEventListener('mousedown', (e) => {
  if (!overMenu(e.clientX, e.clientY)) window.mnu.close();
});

window.mnu.onInit((data) => {
  anchor = (data && data.anchor) || { x: window.screenX, y: window.screenY };
  buildItems(data.items, menuEl, true);
  layoutWindow();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.mnu.close();
});
