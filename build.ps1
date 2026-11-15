# Сборка портативной папки: build\YMMusicWidget
# Внутри — переименованный electron.exe (YMMusicWidget.exe) и приложение
# в resources\app. Работает без Node.js и npm: запускать start.vbs.
#
#   powershell -File build.ps1        # собрать папку
#   powershell -File build.ps1 -Zip   # собрать и упаковать в zip
param([switch]$Zip)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root 'node_modules\electron\dist'
$out  = Join-Path $root 'build\YMMusicWidget'

if (-not (Test-Path $dist)) {
  Write-Error "Missing $dist - run npm install first"
  exit 1
}

# чистая папка сборки
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out -Force | Out-Null

# 1) рантайм Electron целиком (exe, dll, pak, locales, resources)
Copy-Item (Join-Path $dist '*') $out -Recurse -Force
Remove-Item (Join-Path $out 'debug.log') -ErrorAction SilentlyContinue
Rename-Item (Join-Path $out 'electron.exe') 'YMMusicWidget.exe'

# 2) приложение в resources\app — так exe стартует сразу с нашим кодом
$app = Join-Path $out 'resources\app'
New-Item -ItemType Directory -Path $app -Force | Out-Null
$files = @(
  'package.json',
  'main.js', 'clock-main.js',
  'renderer.js', 'clock-renderer.js',
  'preload.js', 'preload-clock.js', 'preload-menu.js',
  'cdp.js', 'smtc.js', 'ym-api.js', 'foreground.js',
  'menu-popup.js', 'menu-popup.html', 'menu-popup.css', 'menu-popup-renderer.js',
  'index.html', 'styles.css', 'clock.html', 'clock.css',
  'icon.ico', 'vendor'
)
foreach ($f in $files) {
  Copy-Item (Join-Path $root $f) $app -Recurse -Force
}

# 3) starter scripts and instructions (everything from portable\)
Get-ChildItem (Join-Path $root 'portable') -File | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $out $_.Name) -Force
}

# 4) zip по желанию
if ($Zip) {
  $zipPath = Join-Path $root 'build\YMMusicWidget-portable.zip'
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zipPath -Force
  Write-Host "OK: $zipPath"
}

Write-Host "OK: $out"
