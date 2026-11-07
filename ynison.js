/**
 * Ynison — реальный протокол Яндекс Музыки для синхронизации состояния
 * воспроизведения между устройствами. Через него мы получаем трек,
 * который играет на любом устройстве Яндекс Музыки (телефон, колонка, веб),
 * и отправляем команды (play/pause/next/prev) активному устройству.
 *
 * Схема: 1) получаем redirect на благословенный хост + ticket,
 *        2) подключаемся к ynison_state.PutYnisonState и слушаем state.
 * (Подход скопирован с рабочей интеграции yandex_music_nowplaying.)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// Патченная копия ws: Яндекс передаёт JSON-блобу в Sec-WebSocket-Protocol,
// стандартная валидация токенов это запрещает — используем websocket-relaxed.
// (Требование по прямому пути, т.к. субпуть "ws" не экспортирует.)
// Приоритет — вендоренная копия из репозитория; в node_modules остаётся запасной.
const relaxedPath = path.join(__dirname, 'vendor', 'ws', 'lib', 'websocket-relaxed.js');
const fallbackPath = path.join(__dirname, 'node_modules', 'ws', 'lib', 'websocket-relaxed.js');
const WebSocket = require(fs.existsSync(relaxedPath) ? relaxedPath : fallbackPath);

const REDIRECT_URL =
  'wss://ynison.music.yandex.ru/redirector.YnisonRedirectService/GetRedirectToYnison';

class Ynison {
  constructor(token, onState) {
    this.token = token;
    this.onState = onState;
    this.deviceId = crypto.randomBytes(8).toString('hex'); // 16 символов
    this.ws = null;
    this.stopped = false;
    this.lastData = null;      // последнее полное состояние (для мутаций команд)
    this.pingTimer = null;
    this.goAwayUntil = 0;      // сервер может попросить тишину (ynison-go-away-for-seconds)

    this.deviceInfo = JSON.stringify({
      app_name: 'YMMusicWidget',
      app_version: '1.0.0',
      type: 1,
    });
  }

  start() {
    this.stopped = false;
    this._loop();
  }

  stop() {
    this.stopped = true;
    this._closeWs();
  }

  _closeWs() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try { this.ws.terminate(); } catch (_) {}
      this.ws = null;
    }
  }

  _wsProtoParts(extraProto) {
    const obj = {
      'Ynison-Device-Id': this.deviceId,
      'Ynison-Device-Info': this.deviceInfo,
      ...extraProto,
    };
    return {
      protocols: ['Bearer', 'v2', JSON.stringify(obj)],
      headers: {
        Origin: 'http://music.yandex.ru',
        Authorization: `OAuth ${this.token}`,
      },
    };
  }
  _loop() {
    // Официальный лестер Яндекс-клиентов: 1/5/30 сек (см. retry-manager Android клиента)
    const ladder = [1000, 5000, 30000];
    let li = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      while (!this.stopped) {
        if (this.goAwayUntil > Date.now()) {
          console.log('[ynison] сервер просил паузу до ' + new Date(this.goAwayUntil).toLocaleTimeString());
          await sleep(Math.min(this.goAwayUntil - Date.now(), 600000));
          continue;
        }
        if (this.stopped) return;
        this._healthyThisRun = false;
        let err = null;
        try {
          await this._connectOnce(); // ждёт, пока жива сессия
        } catch (e) {
          err = e;
          console.error('[ynison] ошибка цикла:', e.message);
        }
        if (this.stopped) return;
        if (this._healthyThisRun) {
          li = 0; // лестница сбрасывается после здоровой сессии
        } else {
          await sleep(ladder[li]);
          li = Math.min(li + 1, ladder.length - 1);
        }
      }
    })();
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      // 1) редирект: получаем host + redirect_ticket
      const p1 = this._wsProtoParts();
      const r1 = new WebSocket(REDIRECT_URL, p1.protocols, { headers: p1.headers });
      const finishErr = (e) => {
        try { r1.terminate(); } catch (_) {}
        reject(e || new Error('redirect failed'));
      };
      let gotData = false;
      r1.on('error', finishErr);
      r1.on('close', () => {
        if (!gotData) finishErr(new Error('redirect closed'));
      });
      r1.on('message', (data) => {
        gotData = true;
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (_) { return finishErr(new Error('bad redirect json')); }
        const { host, redirect_ticket } = msg;
        try { r1.close(); } catch (_) {}
        if (!host || !redirect_ticket) return finishErr(new Error('недостаточно данных redirect'));

        // r2 могло остухнуть раньше — снимем его завершающщее поведение
        r1.removeAllListeners('close');
        r1.removeAllListeners('error');

        // 2) подключение к состоянию с ticket'ом
        const p2 = this._wsProtoParts({ 'Ynison-Redirect-Ticket': redirect_ticket });
        const r2 = new WebSocket(
          `wss://${host}/ynison_state.YnisonStateService/PutYnisonState`,
          p2.protocols,
          { headers: p2.headers }
        );
        r2.on('error', finishErr);
        r2.on('close', () => finishErr(!this.stopped ? new Error('state closed') : null));
        r2.on('open', () => this._sendBootstrap(r2));
        r2.on('message', (raw) => this._handleMessage(raw.toString()));

        // keep-alive: пингуем каждые 20 секунд
        this.pingTimer = setInterval(() => {
          try { r2.ping(); } catch (_) {}
        }, 20000);
        this.ws = r2;
        console.log('[ynison] подключено, host=' + host);
      });
    });
  }

  _sendBootstrap(ws) {
    const bootstrap = {
      update_full_state: {
        player_state: {
          player_queue: {
            current_playable_index: -1,
            entity_id: '',
            entity_type: 'VARIOUS',
            playable_list: [],
            options: { repeat_mode: 'NONE' },
            entity_context: 'BASED_ON_ENTITY_BY_DEFAULT',
            version: this._version(),
            from_optional: '',
          },
          status: {
            duration_ms: 0,
            paused: true,
            playback_speed: 1,
            progress_ms: 0,
            version: this._version(),
          },
        },
        device: {
          capabilities: {
            can_be_player: false,
            can_be_remote_controller: true,
            volume_granularity: 16,
          },
          info: {
            device_id: this.deviceId,
            type: 'WEB',
            title: 'Яндекс Музыка · виджет',
            app_name: 'YMMusicWidget',
          },
          volume_info: { volume: 0 },
          is_shadow: true,
        },
        is_currently_active: false,
      },
      rid: this.deviceId,
      player_action_timestamp_ms: 0,
      activity_interception_type: 'DO_NOT_INTERCEPT_BY_DEFAULT',
    };
    ws.send(JSON.stringify(bootstrap));
  }

  _version() {
    return {
      device_id: this.deviceId,
      version: 0,
      timestamp_ms: 0,
    };
  }

  _handleMessage(text) {
    try {
      const data = JSON.parse(text);

      // серверная ошибка (в т.ч. go-away)
      if (data && data.error) {
        const d = data.error.details || {};
        const sec = parseInt(d['ynison-go-away-for-seconds'], 10) || 0;
        console.error(
          '[ynison] ошибка сервера: code=' + (d['ynison-error-code'] || data.error.grpc_code) +
          (sec ? '; просит не подключаться ' + sec + ' сек' : '')
        );
        if (sec > 0) this.goAwayUntil = Date.now() + sec * 1000;
        this._closeWs(); // r2 close -> reject -> цикл уважит go-away
        return;
      }

      this._healthyThisRun = true;
      this.lastData = data;

      const ps = (data.player_state || {});
      const q = (ps.player_queue || {});
      const status = (ps.status || {});

      const idx = q.current_playable_index;
      const list = q.playable_list || [];
      let playableId = null;
      if (typeof idx === 'number' && idx >= 0 && idx < list.length) {
        const p = list[idx] || {};
        playableId = p.playable_id || p.id;
      }
      this.onState({
        trackId: normalizeTrackId(playableId),
        paused: !!status.paused,
        progressMs: status.progress_ms || 0,
        durationMs: status.duration_ms || 0,
        playbackSpeed: status.playback_speed || 1,
        timestampMs: (status.version && status.version.timestamp_ms) || Date.now(),
        receivedAt: Date.now(),
      });
    } catch (e) {
      console.error('[ynison] ошибка разбора state:', e.message);
    }
  }

  // ------- управление плеером (команды активному устройству) -------

  _bump(objVersion) {
    objVersion.device_id = this.deviceId;
    objVersion.version = (objVersion.version || 0) + 1;
    objVersion.timestamp_ms = Date.now();
  }

  _sendMutated(mutator) {
    const ws = this.ws;
    if (!ws || !this.lastData) return false;
    const clone = JSON.parse(JSON.stringify(this.lastData));
    mutator(clone);
    clone.rid = this.deviceId;
    clone.player_action_timestamp_ms = Date.now();
    try {
      ws.send(JSON.stringify(clone));
      return true;
    } catch (e) {
      return false;
    }
  }

  pause() {
    return this._sendMutated((d) => {
      const st = d.player_state && d.player_state.status;
      if (!st) return;
      st.paused = true;
      this._bump(st.version);
    });
  }

  play() {
    return this._sendMutated((d) => {
      const st = d.player_state && d.player_state.status;
      if (!st) return;
      st.paused = false;
      this._bump(st.version);
    });
  }

  next() {
    return this._skip(1);
  }

  prev() {
    return this._skip(-1);
  }

  _skip(di) {
    return this._sendMutated((d) => {
      const q = d.player_state && d.player_state.player_queue;
      const st = d.player_state && d.player_state.status;
      if (!q || !st) return;
      const n = (q.playable_list || []).length;
      if (!n) return;
      q.current_playable_index = Math.min(Math.max(q.current_playable_index + di, 0), n - 1);
      st.progress_ms = 0;
      this._bump(q.version);
      this._bump(st.version);
    });
  }
}

function normalizeTrackId(playableId) {
  if (!playableId) return null;
  const s = String(playableId);
  if (/^\d+$/.test(s)) return s;
  let m = s.match(/(?:track[:/])(\d+)/);
  if (m) return m[1];
  m = s.match(/(\d+)$/);
  return m ? m[1] : null;
}

module.exports = { Ynison, normalizeTrackId };
