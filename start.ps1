# Запуск виджета и часов Яндекс Музыки.
# Идемпотентно: уже запущенные экземпляры не дублируются.
#
#   .\start.ps1              # виджет + часы
#   .\start.ps1 -Only widget # только виджет
#   .\start.ps1 -Only clock  # только часы
#   .\start.ps1 -Stop        # остановить оба
param(
  [switch]$Stop,
  [ValidateSet('widget', 'clock')]
  [string]$Only = ''
)

$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $dir 'node_modules\electron\dist\electron.exe'

# главные процессы electron этого проекта (дочерние --type=* не главные)
$mine = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '--type=' }

if ($Stop) {
  $mine | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  exit
}

$widgetRunning = @($mine | Where-Object { $_.CommandLine -notmatch '--clock' }).Count -gt 0
$clockRunning  = @($mine | Where-Object { $_.CommandLine -match '--clock' }).Count -gt 0

if (($Only -eq '' -or $Only -eq 'widget') -and -not $widgetRunning) {
  Start-Process -FilePath $exe -ArgumentList @('.') -WorkingDirectory $dir | Out-Null
}
if (($Only -eq '' -or $Only -eq 'clock') -and -not $clockRunning) {
  Start-Process -FilePath $exe -ArgumentList @('.', '--clock') -WorkingDirectory $dir | Out-Null
}
