/* Контекстное меню в popup-окне: строит пункты, меряет, шлёт выбранный id. */

const menuEl = document.getElementById('menu');
const SUB_GAP = 6; // зазор между меню и подменю

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
      row.addEventListener('mouseenter', () => {
        openSub(row, sub);
      });
    } else if (isTop) {
      // наведение на обычный пункт верхнего уровня закрывает чужое подменю
      row.addEventListener('mouseenter', () => {
        if (closeAllSubs()) window.mnu.ready(size());
      });
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
  if (closed) menuEl.style.marginLeft = '';
  return closed;
}

// открыть подменю у строки row: вправо, если есть место, иначе влево
function openSub(row, sub) {
  // закрыть другие открытые подменю
  menuEl.querySelectorAll('.msub.open').forEach((x) => {
    if (x !== sub) x.classList.remove('open');
  });
  sub.classList.add('open');
  const sw = sub.offsetWidth; // ширина подменю (уже display:block)
  const mrect = menuEl.getBoundingClientRect();
  const screenRight = window.screen.availLeft + window.screen.availWidth;
  const menuRight = window.screenX + mrect.right;
  if (menuRight + sw + SUB_GAP <= screenRight) {
    // место справа есть — обычное открытие вправо
    menuEl.style.marginLeft = '';
    sub.style.left = mrect.width - 4 + 'px';
  } else {
    // справа не влезает — открываем влево: сдвигаем меню правее внутри окна,
    // а подменю кладём в освободившуюся зону слева
    const off = sw + SUB_GAP;
    menuEl.style.marginLeft = off + 'px';
    sub.style.left = -off + 'px';
  }
  sub.style.top = row.offsetTop - 6 + 'px';
  window.mnu.ready(size());
}

// размер И положение окна: renderer сам считает экран (DIP), main только применяет
function size() {
  let w = menuEl.offsetWidth, h = menuEl.offsetHeight;
  menuEl.querySelectorAll('.msub.open').forEach((s) => {
    if (s.offsetLeft < 0) {
      // открыто влево: окно должно включить зону слева от меню
      w = Math.max(w, menuEl.offsetWidth - s.offsetLeft);
    } else {
      w = Math.max(w, s.offsetLeft + s.offsetWidth);
    }
    h = Math.max(h, s.offsetTop + s.offsetHeight);
  });
  const scr = window.screen;
  const mrect = menuEl.getBoundingClientRect();
  let x = window.screenX + mrect.left;
  let y = window.screenY + mrect.top;
  if (x + w > scr.availLeft + scr.availWidth) x = scr.availLeft + scr.availWidth - w;
  if (x < scr.availLeft) x = scr.availLeft;
  if (y + h > scr.availTop + scr.availHeight) y = scr.availTop + scr.availHeight - h;
  if (y < scr.availTop) y = scr.availTop;
  return { x: Math.round(x), y: Math.round(y), w, h };
}

// уход мыши за пределы меню — закрыть подменю и вернуть окно к размеру меню
menuEl.addEventListener('mouseleave', () => {
  if (closeAllSubs()) window.mnu.ready(size());
});

window.mnu.onInit((data) => {
  buildItems(data.items, menuEl, true);
  window.mnu.ready(size());
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.mnu.close();
});
