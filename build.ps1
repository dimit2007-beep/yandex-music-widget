# Build the portable folder: build\YMMusicWidget
# Layout: launchers + instructions at the root, the whole runtime (renamed
# electron.exe, dlls, resources) inside app\. Runs without Node.js and npm:
# start via the .vbs files.
#
#   powershell -File build.ps1        # build the folder
#   powershell -File build.ps1 -Zip   # build and pack into a zip
param([switch]$Zip)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root 'node_modules\electron\dist'
$out  = Join-Path $root 'build\YMMusicWidget'
$appDir = Join-Path $out 'app'

if (-not (Test-Path $dist)) {
  Write-Error "Missing $dist - run npm install first"
  exit 1
}

# clean build folder
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out -Force | Out-Null
New-Item -ItemType Directory -Path $appDir -Force | Out-Null

# 1) electron runtime -> app\ (exe, dll, pak, locales, resources)
Copy-Item (Join-Path $dist '*') $appDir -Recurse -Force
Remove-Item (Join-Path $appDir 'debug.log') -ErrorAction SilentlyContinue
Rename-Item (Join-Path $appDir 'electron.exe') 'YMMusicWidget.exe'

# 2) app code -> app\resources\app (this is how the exe boots our code)
$app = Join-Path $appDir 'resources\app'
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

# 3) launchers and instructions (everything from portable\) -> root
Get-ChildItem (Join-Path $root 'portable') -File | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $out $_.Name) -Force
}

# 4) .vbs -> UTF-16LE so WScript reads Cyrillic strings correctly on any locale
Get-ChildItem $out -Filter '*.vbs' | ForEach-Object {
  $t = [IO.File]::ReadAllText($_.FullName, [System.Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($_.FullName, $t, [System.Text.Encoding]::Unicode)
}

# 5) zip on request
if ($Zip) {
  $zipPath = Join-Path $root 'build\YMMusicWidget-portable.zip'
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zipPath -Force
  Write-Host "OK: $zipPath"
}

Write-Host "OK: $out"
