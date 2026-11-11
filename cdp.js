/**
 * CDP-интеграция с десктоп-приложением Яндекс Музыки.
 * Приложение — Electron: при запуске с --remote-debugging-port=9222 мы
 * подключаемся к его окну (music-application://desktop) и снимаем живое
 * состояние плеера из DOM (название, обложка, прогресс, лайк),
 * а также кликаем кнопки (пауза/след/пред/лайк).
 */
const http = require('http');
const WebSocket = require('ws');

const PORT = 9222;

const STATE_EXPR = `(() => {
  const bar = document.querySelector('[data-test-id=VIBE_PLAYERBAR]');
  if (!bar) return null;
  const names = [...bar.querySelectorAll('[data-test-id=VIBE_PLAYERBAR_TRACK_NAME] div')]
    .filter((e) => !e.hasAttribute('aria-hidden'));
  const links = [...bar.querySelectorAll('a')];
  const albumEl = links.filter((a) => (a.getAttribute('href') || '').indexOf('albumId') !== -1)[0];
  const inputs = [...bar.querySelectorAll('input[type=range]')];
  const slider = inputs.filter((i) => i.getAttribute('aria-valuetext'))[0] || inputs[inputs.length - 1];
  const cover = bar.querySelector('img');
  const t0 = bar.querySelector('[data-test-id=TIMECODE_TIME_START]');
  const t1 = bar.querySelector('[data-test-id=TIMECODE_TIME_END]');
  const pause = bar.querySelector('[data-test-id=PAUSE_BUTTON]');
  const like = bar.querySelector('[data-test-id=LIKE_BUTTON]');
  return JSON.stringify({
    title: names.length ? names[names.length - 1].textContent.trim() : null,
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
              artists: null, // подтягивается из REST по albumId
              cover: raw.cover,
              albumHref: raw.albumHref,
              progressMs: raw.sv != null ? parseInt(raw.sv, 10) * 1000 : parseTimeToMs(raw.cur) || 0,
              durationMs: raw.smax != null ? parseInt(raw.smax, 10) * 1000 : parseTimeToMs(raw.end) || 0,
              // SMTC-подобная схема прогресса: локально тикаем сами
              timestampMs: Date.now(),
              receivedAt: Date.now(),
              ts: Date.now(),
              paused: !!raw.paused,
              liked: raw.liked === true || raw.liked === 'true',
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

  async playPause() {
    // при паузе кнопка play, при игре — pause: жмём ту, что есть
    try {
      let ok = await this._click('[data-test-id=PAUSE_BUTTON]');
      if (!ok) ok = await this._eval(
        `(() => {
          const btn = [...document.querySelectorAll('[data-test-id=VIBE_PLAYERBAR] button')]
            .find((b) => b.getAttribute('aria-label') === 'Воспроизведение');
          if (btn) { btn.click(); return true; }
          return false;
        })()`
      );
      return !!ok;
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
    try { return await this._click('[data-test-id=LIKE_BUTTON]'); } catch (_) { return false; }
  }
}

// перезапуск приложения с флагом отладки.
// force=true — перезапустить даже если порт уже открыт (пункт меню «Перезапустить»);
// force=false — только если ЯМ запущена без порта (автоматический помощник).
function buildRestartPs(force = false) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$conn = Test-NetConnection 127.0.0.1 -Port ${PORT} -WarningAction SilentlyContinue
if ($force -or -not $conn.TcpTestSucceeded) {
  $main = Get-CimInstance Win32_Process | Where-Object {
    ($_.CommandLine -match 'YandexMusic|Яндекс Музыка') -and
    ($_.CommandLine -notmatch '--type=') -and
    ($_.ExecutablePath -notmatch 'updater')
  } | Select-Object -First 1
  if ($main) {
    Stop-Process -Id $main.ProcessId -Force
    Start-Sleep -Milliseconds 2000
    Start-Process $main.ExecutablePath -ArgumentList '--remote-debugging-port=${PORT}'
    Write-Output 'restarted'
  } else {
    # приложение вообще не запущено — поднимаем сами из стандартного места установки
    $dir = Join-Path $env:LOCALAPPDATA 'Programs\\YandexMusic'
    $exe = Get-ChildItem $dir -Filter '*.exe' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notmatch 'updater|setup|crash' } |
      Select-Object -First 1 -ExpandProperty FullName
    if ($exe) {
      Start-Process $exe -ArgumentList '--remote-debugging-port=${PORT}'
      Write-Output 'started'
    } else {
      Write-Output 'not-found'
    }
  }
}
`;
}

module.exports = { CdpWatcher, buildRestartPs };
