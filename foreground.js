/**
 * Смотритель активного окна: рабочий стол (Progman/WorkerW) или что-то другое.
 * Долгоживущий PowerShell-процесс печатает JSON-строку при смене режима.
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
}
"@
$last = ''
while ($true) {
  $h = [FG]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 256
  [FG]::GetClassName($h, $sb, 256) | Out-Null
  $cls = $sb.ToString()
  $mode = if ($cls -eq 'Progman' -or $cls -eq 'WorkerW' -or $cls -eq 'SHELLDLL_DefView') { 'desktop' } else { 'window' }
  if ($mode -ne $last) {
    $last = $mode
    [Console]::Out.WriteLine($mode)
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 400
}
`;

class ForegroundWatcher {
  constructor(onMode) {
    this.onMode = onMode;
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
        if (line === 'desktop' || line === 'window') this.onMode(line);
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
