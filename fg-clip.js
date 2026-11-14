/**
 * Режим «только рабочий стол»: окно, наехавшее на плашку, прячет не её целиком,
 * а только перекрытую часть. Перекрытая часть делается прозрачной «дыркой»
 * (clip-path в рендерере) — сквозь неё видно окно, оказавшееся под виджетом.
 * Общая геометрия для виджета музыки и для часов.
 */

// пересечение границ активного окна с окном плашки → прямоугольник «дырки»
// в координатах плашки (CSS px = DIP), или null, если не пересекаются
function computeHole(winBounds, fgRect) {
  if (!winBounds || !fgRect) return null;
  const x = Math.max(0, Math.round(fgRect.x - winBounds.x));
  const y = Math.max(0, Math.round(fgRect.y - winBounds.y));
  const right = Math.min(winBounds.width, Math.round(fgRect.x + fgRect.w - winBounds.x));
  const bottom = Math.min(winBounds.height, Math.round(fgRect.y + fgRect.h - winBounds.y));
  const w = right - x;
  const h = bottom - y;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

// clip-path, оставляющий видимой всю плашку, кроме дырки.
// Возвращает { covered, clip }:
//   covered=true — дырка накрывает плашку целиком (окно наехало целиком или
//                  целиком внутри неё) — плашку прячем целиком, clip не строится;
//   clip=null    — дырки нет, clip-path не трогаем;
//   иначе        — строка clip-path (polygon; для «дырки во всю ширину/высоту» —
//                  path из двух прямоугольников, т.к. видны две полосы).
function buildClip(w, h, hole) {
  if (!hole || w <= 0 || h <= 0) return { covered: false, clip: null };
  const L = hole.x <= 0;
  const T = hole.y <= 0;
  const R = hole.x + hole.w >= w;
  const B = hole.y + hole.h >= h;
  const n = (L ? 1 : 0) + (T ? 1 : 0) + (R ? 1 : 0) + (B ? 1 : 0);
  // окно целиком внутри плашки (кольцо) одним полигононом не выражается —
  // редкий случай прячем плашку целиком
  if (n === 0 || n === 4) return { covered: true, clip: null };
  const poly = (pts) => 'polygon(' + pts.map((p) => p[0] + 'px ' + p[1] + 'px').join(',') + ')';
  const rpath = (x0, y0, x1, y1) =>
    'M' + x0 + ' ' + y0 + 'L' + x1 + ' ' + y0 + 'L' + x1 + ' ' + y1 + 'L' + x0 + ' ' + y1 + 'Z';
  if (n === 3) {
    // дырка на три стороны — видна полоса у четвёртой
    if (!L) return { covered: false, clip: poly([[0, 0], [hole.x, 0], [hole.x, h], [0, h]]) };
    if (!R) return { covered: false, clip: poly([[hole.x + hole.w, 0], [w, 0], [w, h], [hole.x + hole.w, h]]) };
    if (!T) return { covered: false, clip: poly([[0, 0], [w, 0], [w, hole.y], [0, hole.y]]) };
    return { covered: false, clip: poly([[0, hole.y + hole.h], [w, hole.y + hole.h], [w, h], [0, h]]) };
  }
  if (n === 2) {
    // дырка в углу — Г-образный остаток
    if (L && T) return { covered: false, clip: poly([[hole.x + hole.w, 0], [w, 0], [w, h], [0, h], [0, hole.y + hole.h], [hole.x + hole.w, hole.y + hole.h]]) };
    if (T && R) return { covered: false, clip: poly([[0, 0], [hole.x, 0], [hole.x, hole.y + hole.h], [w, hole.y + hole.h], [w, h], [0, h]]) };
    if (L && B) return { covered: false, clip: poly([[0, 0], [w, 0], [w, hole.y], [hole.x + hole.w, hole.y], [hole.x + hole.w, h], [0, h]]) };
    if (B && R) return { covered: false, clip: poly([[0, 0], [w, 0], [w, hole.y], [hole.x, hole.y], [hole.x, h], [0, h]]) };
    // дырка во всю ширину — видны верхняя и нижняя полосы
    if (L && R) {
      return {
        covered: false,
        clip: 'path("' + rpath(0, 0, w, hole.y) + ' ' + rpath(0, hole.y + hole.h, w, h) + '")',
      };
    }
    // дырка во всю высоту (T и B) — видны левая и правая полосы
    return {
      covered: false,
      clip: 'path("' + rpath(0, 0, hole.x, h) + ' ' + rpath(hole.x + hole.w, 0, w, h) + '")',
    };
  }
  // выемка на одном краю
  if (L) return { covered: false, clip: poly([[0, 0], [w, 0], [w, h], [0, h], [0, hole.y + hole.h], [hole.x + hole.w, hole.y + hole.h], [hole.x + hole.w, hole.y], [0, hole.y]]) };
  if (R) return { covered: false, clip: poly([[0, 0], [w, 0], [w, hole.y], [hole.x, hole.y], [hole.x, hole.y + hole.h], [w, hole.y + hole.h], [w, h], [0, h]]) };
  if (T) return { covered: false, clip: poly([[0, 0], [hole.x, 0], [hole.x, hole.y + hole.h], [hole.x + hole.w, hole.y + hole.h], [hole.x + hole.w, 0], [w, 0], [w, h], [0, h]]) };
  return { covered: false, clip: poly([[0, 0], [w, 0], [w, h], [hole.x + hole.w, h], [hole.x + hole.w, hole.y], [hole.x, hole.y], [hole.x, h], [0, h]]) };
}

module.exports = { computeHole, buildClip };
