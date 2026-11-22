/**
 * CDP-интеграция с десктоп-приложением Яндекс Музыки.
 * Приложение — Electron: при запуске с --remote-debugging-port=9222 мы
 * подключаемся к его окну (music-application://desktop) и снимаем живое
 * состояние плеера из DOM (название, обложка, прогресс, лайк),
 * а также кликаем кнопки (пауза/след/пред/лайк).
 */
const http = require('http');
const WebSocket = require('./vendor/ws'); // вендорная копия ws: приложение не требует npm install

const PORT = 9222;

const STATE_EXPR = `(() => {
  // Плеербар в приложении ЯМ бывает двух видов: VIBE_PLAYERBAR на Главной
  // («Моя волна») и PLAYERBAR_DESKTOP на остальных страницах (поиск, артист,
  // текст песни). Читаем оба, иначе на не-главных страницах виджет слепнет.
  const bar = document.querySelector('[data-test-id=VIBE_PLAYERBAR]')
    || document.querySelector('[data-test-id=PLAYERBAR_DESKTOP]');
  if (!bar) return null;
  // название: у VIBE — контейнер VIBE_PLAYERBAR_TRACK_NAME (последний
  // видимый div), у десктопного — ссылка TRACK_TITLE
  let title = null;
  const vibeNames = [...bar.querySelectorAll('[data-test-id=VIBE_PLAYERBAR_TRACK_NAME] div')]
    .filter((e) => !e.hasAttribute('aria-hidden'));
  if (vibeNames.length) title = vibeNames[vibeNames.length - 1].textContent.trim();
  if (!title) {
    const t = bar.querySelector('[data-test-id=TRACK_TITLE]');
    if (t) title = t.textContent.trim();
  }
  // артисты: у десктопного плеербара каждая ссылка сама помечена
  // data-test-id=SEPARATED_ARTIST_TITLE (по одной на артиста)
  let artists = null;
  const sepEls = [...bar.querySelectorAll('[data-test-id=SEPARATED_ARTIST_TITLE]')];
  if (sepEls.length) {
    const names = [...new Set(sepEls.map((e) => (e.textContent || '').trim()).filter(Boolean))];
    if (names.length) artists = names.join(', ');
  }
  const cover = bar.querySelector('[data-test-id=ENTITY_COVER_IMAGE]') || bar.querySelector('img');
  const links = [...bar.querySelectorAll('a')];
  const albumEl = links.filter((a) => (a.getAttribute('href') || '').indexOf('albumId') !== -1)[0];
  // trackId прямо из ссылки на трек: точнее, чем искать трек по названию
  const trackEl = links.filter((a) => /(?:^|[?&])trackId=\\d+/.test(a.getAttribute('href') || ''))[0];
  const trackId = trackEl ? (/trackId=(\\d+)/.exec(trackEl.getAttribute('href')) || [])[1] || null : null;
  // прогресс: приоритет TIMECODE_SLIDER — на страницах поиска/артиста в
  // баре есть ещё слайдер громкости, «последний input» брать нельзя
  const slider = bar.querySelector('[data-test-id=TIMECODE_SLIDER]')
    || [...bar.querySelectorAll('input[type=range]')].filter((i) => i.getAttribute('aria-valuetext'))[0];
  const t0 = bar.querySelector('[data-test-id=TIMECODE_TIME_START]');
  const t1 = bar.querySelector('[data-test-id=TIMECODE_TIME_END]');
  const pause = bar.querySelector('[data-test-id=PAUSE_BUTTON]');
  const like = bar.querySelector('[data-test-id=LIKE_BUTTON]');
  return JSON.stringify({
    title,
    artists,
    trackId,
    cover: cover ? cover.getAttribute('src') : null,
    albumHref: albumEl ? albumEl.getAttribute('href') : null,
    cur: t0 ? t0.textContent.trim() : null,
    end: t1 ? t1.textContent.trim() : null,
    sv: slider ? slider.value : null,
    smax: slider ? slider.max : null,
    paused: !pause,
    liked: like ? like.getAttribute('aria-pressed') : null,
  });
})()`;

function _s(v) {
  return String(v == null ? '' : v).trim();
}

// обложка в плеербаре отдаётся как 100x100; для плашки берём крупнее
function bigCover(url) {
  const s = _s(url);
  return s ? s.replace(/\/(\d{2,4})x(\d{2,4})(?=[./?]|$)/, '/400x400') : null;
}

function parseTimeToMs(t) {
  const m = /^(\d+):(\d{2})$/.exec(_s(t));
  if (!m) return null;
  return (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000;
}

class CdpWatcher {
  constructor(onState) {
    this.onState = onState;
    this.ws = null;
    this.reqId = 0;
    this.pending = new Map();
    this.targetId = null;
    this.stopped = false;
    this.lastOkAt = 0;
    this.portUpAt = 0; // когда 9222 последний раз отвечал (ЯМ запущена с портом)
  }

  start() {
    this.stopped = false;
    this.timer = setInterval(() => this._tick(), 2000);
    this._tick();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this._closeWs();
  }

  get fresh() {
    return Date.now() - this.lastOkAt < 15000;
  }

  // порт отвечает, но состояние ещё не читается: ЯМ запущена с портом
  // и грузится — в этот момент её перезапускать нельзя
  get portUp() {
    return Date.now() - this.portUpAt < 8000;
  }

  _closeWs() {
    if (this.ws) {
      try { this.ws.terminate(); } catch (_) {}
      this.ws = null;
      this.targetId = null;
    }
  }

  _targets() {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(1500, () => { req.destroy(new Error('timeout')); });
    });
  }

  _eval(expr) {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== 1) return reject(new Error('cdp: нет ws'));
      const id = ++this.reqId;
      this.pending.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, userGesture: true } }));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('cdp: eval timeout'));
        }
      }, 3000);
    });
  }

  async _tick() {
    if (this.stopped) return;
    try {
      const list = await this._targets();
      this.portUpAt = Date.now(); // порт отвечает
      // ВАЖНО: у приложения несколько page-таргетов (главное окно + мини/фулскрин
      // плеер) с разными состояниями. Порядок в /json может меняться — если
      // каждый тик брать первый попавшийся, мы переподключаемся и получаем
      // противоречивые состояния (иконка паузы мигает). Держимся за уже
      // подключённый таргет, пока он жив.
      const page = list.find((t) => t.type === 'page' && t.id === this.targetId)
        || list.find((t) => t.type === 'page' && (t.url || '').startsWith('music-application://'));
      if (!page) return;
      if (!this.ws || this.targetId !== page.id) {
        this._closeWs();
        this.targetId = page.id;
        this._openWs(page.webSocketDebuggerUrl);
      }
      if (this.ws && this.ws.readyState === 1) {
        const res = await this._eval(STATE_EXPR);
        if (res && typeof res === 'string') {
          const raw = JSON.parse(res);
          if (raw && raw.title) {
            this.lastOkAt = Date.now();
            this.onState({
              title: raw.title,
              artists: raw.artists || null, // на не-главных страницах есть в DOM
              trackId: raw.trackId || null, // точнее поиска по названию
              cover: bigCover(raw.cover),
              albumHref: raw.albumHref,
              progressMs: raw.sv != null ? parseInt(raw.sv, 10) * 1000 : parseTimeToMs(raw.cur) || 0,
              durationMs: raw.smax != null ? parseInt(raw.smax, 10) * 1000 : parseTimeToMs(raw.end) || 0,
              // SMTC-подобная схема прогресса: локально тикаем сами
              timestampMs: Date.now(),
              receivedAt: Date.now(),
              ts: Date.now(),
              paused: !!raw.paused,
              // null = бар не дал состояние лайка (тогда решает REST-кэш)
              liked: raw.liked === 'true' ? true : raw.liked === 'false' ? false : null,
            });
          }
        }
      }
    } catch (_) {
      /* нет порта/приложения — тихо ждём */
    }
  }

  _openWs(url) {
    this.pending.clear();
    const ws = new WebSocket(url);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error('cdp: ' + JSON.stringify(msg.error)));
          else p.resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
        }
      } catch (_) {}
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.targetId = null;
      }
    });
    this.ws = ws;
  }

  // ------- действия через DOM -------

  async _click(selector) {
    if (!this.fresh) return false;
    const ok = await this._eval(
      `(() => {
        const b = document.querySelector('${selector}');
        if (b) { b.click(); return true; }
        return false;
      })()`
    );
    return !!ok;
  }

  // клик строго внутри плеербара: PLAY_BUTTON есть и в списках треков,
  // поэтому глобальный querySelector мог нажать «играть» не у того трека
  async _clickInBars(selector) {
    if (!this.fresh) return false;
    const ok = await this._eval(
      `(() => {
        const bar = document.querySelector('[data-test-id=VIBE_PLAYERBAR]')
          || document.querySelector('[data-test-id=PLAYERBAR_DESKTOP]');
        if (!bar) return false;
        const b = bar.querySelector('${selector}');
        if (b) { b.click(); return true; }
        return false;
      })()`
    );
    return !!ok;
  }

  async playPause() {
    // при паузе кнопка play, при игре — pause: жмём ту, что есть
    try {
      if (await this._clickInBars('[data-test-id=PAUSE_BUTTON]')) return true;
      if (await this._clickInBars('[data-test-id=PLAY_BUTTON]')) return true;
      // запасной путь: кнопка с подписью «Воспроизведение» в самом баре
      return !!(await this._eval(
        `(() => {
          const bar = document.querySelector('[data-test-id=VIBE_PLAYERBAR]')
            || document.querySelector('[data-test-id=PLAYERBAR_DESKTOP]');
          if (!bar) return false;
          const btn = [...bar.querySelectorAll('button')]
            .find((b) => /^(Воспроизведение|Воспроизвести|Play)$/i.test(b.getAttribute('aria-label') || ''));
          if (btn) { btn.click(); return true; }
          return false;
        })()`
      ));
    } catch (_) {
      return false;
    }
  }

  async next() {
    try { return await this._click('[data-test-id=NEXT_TRACK_BUTTON]'); } catch (_) { return false; }
  }

  async prev() {
    try { return await this._click('[data-test-id=PREVIOUS_TRACK_BUTTON]'); } catch (_) { return false; }
  }

  async toggleLike() {
    // на страницах поиска/артиста LIKE_BUTTON есть у каждого трека в списке;
    // глобальный querySelector попал бы в первый трек, а не в текущий
    try { return await this._clickInBars('[data-test-id=LIKE_BUTTON]'); } catch (_) { return false; }
  }
}

// ------- перезапуск ЯМ с портом отладки — чистый Node, без PowerShell -------
// (старый PS-помощник шумел в stderr, молча проваливался на холодном старте
// и однажды запустил деинсталлятор вместо приложения)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

// открыт ли порт отладки (быстрый опрос по HTTP вместо Test-NetConnection)
function isPortUp(timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version', timeout }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// путь до главного exe ЯМ из стандартной папки установки. ВАЖНО: первый
// попавшийся exe по алфавиту — это Uninstall (деинсталлятор), поэтому
// исключаем служебные и берём самый крупный exe — это приложение.
async function findYmExe() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dir = path.join(local, 'Programs', 'YandexMusic');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return null;
  }
  const list = await Promise.all(
    names
      .filter((n) => /\.exe$/i.test(n))
      .map(async (n) => {
        try {
          const st = await fs.promises.stat(path.join(dir, n));
          return { name: n, full: path.join(dir, n), size: st.size };
        } catch (_) {
          return null;
        }
      })
  );
  const exe = list
    .filter(Boolean)
    .filter((e) => !/updater|setup|crash|uninstall/i.test(e.name))
    .sort((a, b) => b.size - a.size)[0];
  return exe ? exe.full : null;
}

// запущена ли ЯМ сейчас: tasklist сам отфильтрует по имени образа, а вывод
// в CSV начинается с кавычки только у строк процессов (служебное сообщение
// "INFO: ..." — без неё), так что разбор не зависит от языка и кодировки
let ymImageCache = '';
async function ymImage() {
  if (!ymImageCache) {
    ymImageCache = path.basename((await findYmExe()) || 'Яндекс Музыка.exe');
  }
  return ymImageCache;
}

function isYmRunning() {
  return ymImage().then((image) => new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq ' + image, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
      const lines = String(stdout || '').split(/\r?\n/).filter((l) => l.charCodeAt(0) === 34);
      resolve(lines.length > 0);
    });
  }));
}

// перезапуск ЯМ с портом отладки. force=true — даже если порт уже открыт
// (пункт меню «Перезапустить»); force=false — только если порт закрыт
// (автоматический помощник). Исход: 'restarted' (была запущена без порта),
// 'started' (была закрыта), 'port-up' (порт уже открыт — делать нечего),
// 'not-found' (не нашли exe).
async function restartYmWithPort(force = false) {
  if (!force && (await isPortUp())) return 'port-up';
  const exe = await findYmExe();
  if (!exe) {
    console.error('[cdp] restart: не нашёл Яндекс Музыку в %LOCALAPPDATA%\\Programs\\YandexMusic');
    return 'not-found';
  }
  const image = path.basename(exe);
  // закрываем все процессы ЯМ; ошибка = не была запущена, это нормально
  const wasRunning = await new Promise((resolve) => {
    execFile('taskkill', ['/F', '/T', '/IM', image], { windowsHide: true }, (err) => resolve(!err));
  });
  await new Promise((r) => setTimeout(r, 2500)); // даём процессам ЯМ полностью закрыться, иначе новый экземпляр может напороться на блокировку профиля
  try {
    const child = spawn(exe, ['--remote-debugging-port=' + PORT], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    child.on('error', (e) => console.error('[cdp] restart: запуск: ' + e.message));
  } catch (e) {
    console.error('[cdp] restart: spawn: ' + e.message);
    return 'error';
  }
  return wasRunning ? 'restarted' : 'started';
}

module.exports = { CdpWatcher, restartYmWithPort, isYmRunning };
