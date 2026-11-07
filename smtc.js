/**
 * Резервный источник «что играет»: Windows SMTC
 * (GlobalSystemMediaTransportControls) — та же интеграция, через которую
 * виджеты и OPS-плеера Windows видят Яндекс Музыку в браузере (Chrome/Edge)
 * или официальном десктоп-приложении.
 *
 * Долгоживущий PowerShell-процесс polls медиа-сессии и печатает JSON-строку
 * при изменении трека/статуса. Команды — системные media-клавиши.
 */
const { spawn } = require('child_process');
const os = require('os');

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$methods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
$asTask = $methods | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Await($op, $type) {
  $tsk = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $tsk.Wait() | Out-Null
  $tsk.Result
}
$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$lastKey = ''
while ($true) {
  $mgr = Await ($mgrType::RequestAsync()) $mgrType
  $sessions = $mgr.GetSessions()
  $s = $sessions | Where-Object { $_.SourceAppUserModelId -match 'yandex' } | Select-Object -First 1
  if (-not $s) { $s = $sessions | Select-Object -First 1 }
  if ($s) {
    $mp = Await $s.GetMediaPropertiesAsync() ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($mp.Title) {
      $pl = $s.GetPlaybackInfo()
      $st = [string]$pl.PlaybackStatus
      $tl = $s.GetTimelineProperties()
      $key = "$($mp.Title)|$($mp.Artist)|$st"
      if ($key -ne $lastKey) {
        $lastKey = $key
        $obj = @{
          app        = $s.SourceAppUserModelId
          title      = $mp.Title
          artists    = $mp.Artist
          album      = $mp.AlbumTitle
          paused     = ($st -ne 'Playing')
          progressMs = [int64]$tl.Position.TotalMilliseconds
          durationMs = [int64]$tl.EndTime.TotalMilliseconds
          ts         = [int64](Get-Date -UFormat %s -Millisecond 000)
        }
        [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
      }
    }
  } elseif ($lastKey) {
    $lastKey = ''
    [Console]::Out.WriteLine('{}')
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 3000
}
`;

class SmtcWatcher {
  constructor(onState) {
    this.onState = onState;
    this.child = null;
    this.buf = '';
    this.stopped = false;
    this.fails = 0;
  }

  start() {
    if (this.stopped) return;
    if (!/^win/.test(os.platform())) return;
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
        try {
          const st = JSON.parse(line);
          if (st && st.title) {
            st.receivedAt = Date.now();
            this.onState(st);
          } else {
            this.onState(null); // ничего не играет
          }
        } catch (_) {}
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

// системные media-клавиши через keybd_event
const VK = { playPause: 0xb3, next: 0xb0, prev: 0xb1 };

function sendMediaKey(which) {
  const vk = VK[which];
  if (!vk) return;
  const ps = `
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);' -Name kb -Namespace w
[w.kb]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero)
[w.kb]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)
`;
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true });
}

module.exports = { SmtcWatcher, sendMediaKey };
