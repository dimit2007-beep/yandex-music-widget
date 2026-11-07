/* Зонд CDP: evaluate-выражение в главном окне Яндекс Музыки.
   Использование: node probe-cdp.js "выражение" */
const http = require('http');
const WebSocket = require('ws');

async function targets() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path: '/json/list' }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
  });
}

async function main() {
  const expr = process.argv[2] || 'location.href';
  const list = await targets();
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('music-application://'));
  if (!page) {
    console.error('нет главного окна ЯМ (ming关注: приложение запущено без --remote-debugging-port)');
    process.exit(1);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const idNext = 1;
  let done = false;
  ws.on('open', () => {
    ws.send(JSON.stringify({
      id: idNext,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true },
    }));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id === idNext) {
      const v = msg.result && msg.result.result ? msg.result.result.value : msg.result;
      console.log(typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v));
      done = true;
      ws.close();
    }
  });
  ws.on('close', () => process.exit(done ? 0 : 1));
  ws.on('error', (e) => console.error('ws:', e.message));
}
main();
