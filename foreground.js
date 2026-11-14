/**
 * Смотритель активного окна: рабочий стол (Progman/WorkerW) или что-то другое.
 * Долгоживущий PowerShell-процесс печатает JSON-строку при смене режима ИЛИ
 * при смене границ активного окна (развёрнутое/перемещённое окно тоже меняет
 * «перекрывает ли оно виджет»):
 *   {"mode":"desktop"}
 *   {"mode":"window","x":..,"y":..,"w":..,"h":..}  — видимые границы в DIP
 * Границы берутся из DWM (без теней и невидимых рамок), делятся на DPI окна.
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
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT pvAttribute, int cbAttribute);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  public struct RECT { public int L, T, R, B; }
}
"@
$last = ''
$lastRect = ''
while ($true) {
  $h = [FG]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 256
  [FG]::GetClassName($h, $sb, 256) | Out-Null
  $cls = $sb.ToString()
  # панель задач и хосты оболочки считаем частью рабочего стола
  $mode = if ($cls -eq 'Progman' -or $cls -eq 'WorkerW' -or $cls -eq 'SHELLDLL_DefView' -or
              $cls -eq 'Shell_TrayWnd' -or $cls -eq 'Shell_SecondaryTrayWnd' -or
              $cls.StartsWith('XamlExplorerHostIslandWindow')) { 'desktop' } else { 'window' }
  $rectStr = ''
  if ($mode -eq 'window') {
    $r = New-Object FG+RECT
    # видимые границы окна (без теней/невидимых рамок); при ошибке — обычный rect
    if ([FG]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -ne 0) { [FG]::GetWindowRect($h, [ref]$r) | Out-Null }
    $dpi = 0
    try { $dpi = [FG]::GetDpiForWindow($h) } catch { $dpi = 0 }
    if ($dpi -le 0) { $dpi = 96 }
    $sf = $dpi / 96.0
    $x = [int]([Math]::Round($r.L / $sf))
    $y = [int]([Math]::Round($r.T / $sf))
    $w = [int]([Math]::Round(($r.R - $r.L) / $sf))
    $hh = [int]([Math]::Round(($r.B - $r.T) / $sf))
    $rectStr = "$x,$y,$w,$hh"
  }
  # печатаем при смене режима или смене границ активного окна
  if ($mode -ne $last -or ($mode -eq 'window' -and $rectStr -ne $lastRect)) {
    $last = $mode
    $lastRect = $rectStr
    if ($mode -eq 'window') {
      $p = $rectStr.Split(',')
      [Console]::Out.WriteLine('{"mode":"window","x":' + $p[0] + ',"y":' + $p[1] + ',"w":' + $p[2] + ',"h":' + $p[3] + '}')
    } else {
      [Console]::Out.WriteLine('{"mode":"desktop"}')
    }
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 400
}
`;

class ForegroundWatcher {
  constructor(onMode) {
    this.onMode = onMode; // вызывается с {mode, x?, y?, w?, h?}
    this.child = null;
    this.buf = '';
    this.stopped = false;
    this.fails = 0;
  }

  start() {
    if (this.stopped) return;
    const enc = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
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
