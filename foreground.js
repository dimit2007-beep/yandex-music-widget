/**
 * Смотритель активного окна: рабочий стол (Progman/WorkerW) или что-то другое.
 * Долгоживущий PowerShell-процесс печатает JSON-строку при смене режима:
 *   {"mode":"desktop"}  — активен рабочий стол (или своё окно: меню, вход)
 *   {"mode":"window"}   — активно чужое окно
 * Режим нужен только для клик-сквози: на рабочем столе плашка интерактивна,
 * при активном приложении — клики сквозь неё (у виджета кроме кнопок).
 * Перекрытие плашек окнами в режиме «только рабочий стол» делает сама
 * Windows: плашка живёт в общем слое окон, и любое окно накрывает её
 * нативно — плавно и точно, активное оно или нет. Поэтому границы окон
 * здесь не нужны.
 * Опрос 200 мс: в цикле только GetForegroundWindow — почти бесплатно.
 */
const { spawn } = require('child_process');

const PS_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$own = __OWN_PID__
$last = ''
while ($true) {
  $h = [FG]::GetForegroundWindow()
  $fp = [uint32]0
  [void][FG]::GetWindowThreadProcessId($h, [ref]$fp)
  $sb = New-Object System.Text.StringBuilder 256
  [void][FG]::GetClassName($h, $sb, 256)
  $cls = $sb.ToString()
  # панель задач и хосты оболочки считаем частью рабочего стола
  $mode = if ($cls -eq 'Progman' -or $cls -eq 'WorkerW' -or $cls -eq 'SHELLDLL_DefView' -or
              $cls -eq 'Shell_TrayWnd' -or $cls -eq 'Shell_SecondaryTrayWnd' -or
              $cls.StartsWith('XamlExplorerHostIslandWindow')) { 'desktop' } else { 'window' }
  # своё окно (popup-меню, окно входа) в фокусе — считаем рабочим столом,
  # иначе виджет на мгновение уйдёт в «сквозной» режим
  if ($own -gt 0 -and $fp -eq $own) { $mode = 'desktop' }
  if ($mode -ne $last) {
    $last = $mode
    [Console]::Out.WriteLine('{"mode":"' + $mode + '"}')
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 200
}
`;

class ForegroundWatcher {
  constructor(onMode, ownPid) {
    this.onMode = onMode; // вызывается с {mode: 'desktop'|'window'}
    this.ownPid = ownPid || 0; // окна этого процесса считаем «рабочим столом»
    this.child = null;
    this.buf = '';
    this.stopped = false;
    this.fails = 0;
  }

  start() {
    if (this.stopped) return;
    const ps = PS_SCRIPT.replace('__OWN_PID__', String(this.ownPid || 0));
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
      { windowsHide: true }
    );
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let info = null;
        try { info = JSON.parse(line); } catch (_) {}
        if (!info || (info.mode !== 'desktop' && info.mode !== 'window')) {
          // совместимость со старым форматом (plain 'desktop'/'window')
          if (line === 'desktop' || line === 'window') info = { mode: line };
          else continue;
        }
        this.onMode(info);
      }
    });
    this.child.on('exit', () => {
      if (this.stopped) return;
      this.fails++;
      setTimeout(() => this.start(), Math.min(2000 * this.fails, 20000));
    });
  }

  stop() {
    this.stopped = true;
    if (this.child) {
      try { this.child.kill(); } catch (_) {}
      this.child = null;
    }
  }
}

module.exports = { ForegroundWatcher };
