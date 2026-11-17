/**
 * Единственность экземпляра приложения — свой лок через именованный pipe
 * Windows, а не requestSingleInstanceLock: тот держит лок на папке userData,
 * которую делят виджет и часы (%APPDATA%\yandex-music-widget) — часы
 * оказались бы «вторым экземпляром» и не запустились бы вовсе.
 * Только net из Node: работает на любой чистой Windows, ничего ставить не нужно.
 */
const net = require('net');

const pipeName = (role) => '\\\\.\\pipe\\ymusic-widget-' + role;

/**
 * Захватить лок. true — мы первые, живём; при «показаться» от второго
 * экземпляра вызовется onSecond(). false — захватить не удалось.
 */
function acquireSingleInstance(role, onSecond) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', (c) => (buf += c));
      socket.on('end', () => {
        if (buf.trim() === 'show' && typeof onSecond === 'function') onSecond();
      });
      socket.on('error', () => {});
    });
    server.on('error', () => resolve(false)); // pipe занят — возможно, уже запущен
    server.listen(pipeName(role), () => resolve(true));
  });
}

/** Скажи первому экземпляру, что его просят показаться. true — дозвонились. */
function notifyFirstInstance(role) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const socket = net.connect(pipeName(role), () => socket.end('show\n'));
      socket.on('error', () => finish(false));
      socket.on('close', () => finish(true));
    } catch (_) {
      finish(false);
    }
    setTimeout(() => finish(false), 1500).unref();
  });
}

module.exports = { acquireSingleInstance, notifyFirstInstance };
