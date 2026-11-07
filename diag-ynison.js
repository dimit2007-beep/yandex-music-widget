/* Диагностика Ynison: полная имитация handshak'а, печать всех кадров и close-кода. */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const WebSocket = require(
  path.join(__dirname, 'vendor', 'ws', 'lib', 'websocket-relaxed.js')
);

const token = JSON.parse(
  fs.readFileSync(path.join(process.env.APPDATA, 'yandex-music-widget', 'token.json'), 'utf8')
).token;

const deviceId = crypto.randomBytes(8).toString('hex');
const deviceInfo = JSON.stringify({ app_name: 'YMMusicWidget', app_version: '1.0.0', type: 1 });

const mk = (extra) => ({
  protocols: ['Bearer', 'v2', JSON.stringify({ 'Ynison-Device-Id': deviceId, 'Ynison-Device-Info': deviceInfo, ...extra })],
  headers: { Origin: 'http://music.yandex.ru', Authorization: `OAuth ${token}` },
});

const p1 = mk({});
const r1 = new WebSocket('wss://ynison.music.yandex.ru/redirector.YnisonRedirectService/GetRedirectToYnison', p1.protocols, { headers: p1.headers });
r1.on('error', (e) => console.error('r1 error:', e.message));
r1.on('message', (d) => {
  const { host, redirect_ticket } = JSON.parse(d.toString());
  console.log('redirect ok: host=' + host + ' ticket=' + String(redirect_ticket).slice(0, 20) + '...');
  r1.close();
  const p2 = mk({ 'Ynison-Redirect-Ticket': redirect_ticket });
  const r2 = new WebSocket(`wss://${host}/ynison_state.YnisonStateService/PutYnisonState`, p2.protocols, { headers: p2.headers });
  r2.on('open', () => {
    console.log('r2 open');
    r2.send(JSON.stringify({
      update_full_state: {
        player_state: {
          player_queue: { current_playable_index: -1, entity_id: '', entity_type: 'VARIOUS', playable_list: [], options: { repeat_mode: 'NONE' }, entity_context: 'BASED_ON_ENTITY_BY_DEFAULT', version: { device_id: deviceId, version: 0, timestamp_ms: 0 }, from_optional: '' },
          status: { duration_ms: 0, paused: true, playback_speed: 1, progress_ms: 0, version: { device_id: deviceId, version: 0, timestamp_ms: 0 } },
        },
        device: {
          capabilities: { can_be_player: true, can_be_remote_controller: false, volume_granularity: 16 },
          info: { device_id: deviceId, type: 'WEB', title: 'YMMusicWidget', app_name: 'YMMusicWidget' },
          volume_info: { volume: 0 },
          is_shadow: true,
        },
        is_currently_active: false,
      },
      rid: deviceId,
      player_action_timestamp_ms: 0,
      activity_interception_type: 'DO_NOT_INTERCEPT_BY_DEFAULT',
    }));
  });
  r2.on('message', (d2) => console.log('r2 msg:', String(d2).slice(0, 500)));
  r2.on('close', (code, reason) => console.log('r2 CLOSE code=' + code + ' reason=' + reason.toString().slice(0, 300)));
  r2.on('error', (e) => console.error('r2 error:', e.message));
  setInterval(() => { try { r2.ping(); } catch (_) {} }, 20000);
});
r1.on('close', (code) => console.log('r1 close code=' + code));
