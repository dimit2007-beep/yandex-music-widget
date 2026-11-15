# Generate clock.ico: yellow rounded square + black clock face,
# styled to match icon.ico (colors and square metrics are probed from it).
# Sizes: 16..128 as BMP entries, 256 as PNG entry (most compatible combo).
# ASCII only: PowerShell 5.1 reads .ps1 without BOM as ANSI.
#
#   powershell -File make-clock-ico.ps1
param([string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Out) { $Out = Join-Path $root 'clock.ico' }
$srcIco = Join-Path $root 'icon.ico'

# ---- probe style from the music icon (its 256x256 PNG entry) ----
$bytes = [IO.File]::ReadAllBytes($srcIco)
$count = [BitConverter]::ToUInt16($bytes, 4)
$pngData = $null
for ($i = 0; $i -lt $count; $i++) {
  $o = 6 + 16 * $i
  $w = $bytes[$o]; if ($w -eq 0) { $w = 256 }
  if ($w -eq 256) {
    $len = [BitConverter]::ToUInt32($bytes, $o + 8)
    $off = [BitConverter]::ToUInt32($bytes, $o + 12)
    $pngData = New-Object byte[] $len
    [Array]::Copy($bytes, $off, $pngData, 0, $len)
  }
}
if (-not $pngData) { throw 'no 256 entry found in icon.ico' }
$ms = New-Object System.IO.MemoryStream(,$pngData)
$ref = [System.Drawing.Image]::FromStream($ms)
$probe = New-Object System.Drawing.Bitmap($ref)
$ref.Dispose(); $ms.Close()

# opaque bounding box
$minX = 256; $minY = 256; $maxX = 0; $maxY = 0
for ($y = 0; $y -lt 256; $y++) {
  for ($x = 0; $x -lt 256; $x++) {
    if ($probe.GetPixel($x, $y).A -gt 128) {
      if ($x -lt $minX) { $minX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
$side = $maxX - $minX + 1
# corner radius: at the topmost row the square starts inset by r
$fx = 0
for ($x = $minX; $x -le $maxX; $x++) { if ($probe.GetPixel($x, $minY).A -gt 128) { $fx = $x; break } }
$radius = $fx - $minX
# square color: middle of the left edge
$sqColor = $probe.GetPixel($minX + 6, [int](($minY + $maxY) / 2))
# glyph color: darkest opaque pixel
$best = 999.0; $glyph = [System.Drawing.Color]::Black
for ($y = 0; $y -lt 256; $y++) {
  for ($x = 0; $x -lt 256; $x++) {
    $c = $probe.GetPixel($x, $y)
    if ($c.A -gt 128) {
      $l = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
      if ($l -lt $best) { $best = $l; $glyph = $c }
    }
  }
}
$probe.Dispose()
Write-Host ("probe: square x={0} y={1} side={2} r={3}; square=#{4:X2}{5:X2}{6:X2}; glyph=#{7:X2}{8:X2}{9:X2}" -f `
  $minX, $minY, $side, $radius, $sqColor.R, $sqColor.G, $sqColor.B, $glyph.R, $glyph.G, $glyph.B)

# ---- render the clock at a given size ----
function New-ClockBitmap([int]$s) {
  $scale = $s / 256.0
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  try {
    # rounded square (same geometry as the music icon)
    $r = $radius * $scale; $x = $minX * $scale; $y = $minY * $scale; $sd = $side * $scale
    $d = 2 * $r
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $sd - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $sd - $d, $y + $sd - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $sd - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $fill = New-Object System.Drawing.SolidBrush($sqColor)
    $g.FillPath($fill, $path)
    $fill.Dispose(); $path.Dispose()

    # clock face, centered in the square (design space: 256)
    $cx = 128 * $scale; $cy = 128 * $scale
    $ringW = 17 * $scale
    $pen = New-Object System.Drawing.Pen($glyph, $ringW)
    $g.DrawEllipse($pen, ($cx - 76 * $scale), ($cy - 76 * $scale), (152 * $scale), (152 * $scale))

    # hands at 10:10 (classic watch-ad position)
    foreach ($hand in @(@{ deg = 305; len = 42; w = 21 }, @{ deg = 60; len = 58; w = 16 })) {
      $t = $hand.deg * [Math]::PI / 180.0
      $hx = $cx + [Math]::Sin($t) * $hand.len * $scale
      $hy = $cy - [Math]::Cos($t) * $hand.len * $scale
      $hp = New-Object System.Drawing.Pen($glyph, ($hand.w * $scale))
      $hp.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $hp.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
      $g.DrawLine($hp, $cx, $cy, [single]$hx, [single]$hy)
      $hp.Dispose()
    }
    # center dot
    $dot = New-Object System.Drawing.SolidBrush($glyph)
    $g.FillEllipse($dot, ($cx - 11 * $scale), ($cy - 11 * $scale), (22 * $scale), (22 * $scale))
    $dot.Dispose(); $pen.Dispose()
  } finally {
    $g.Dispose()
  }
  return $bmp
}

# ---- BMP entry: BITMAPINFOHEADER + bottom-up BGRA + zero AND mask ----
function ConvertTo-BmpEntry([System.Drawing.Bitmap]$bmp) {
  $s = $bmp.Width
  $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
  $d = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $pix = New-Object byte[] (4 * $s * $s)
  for ($y = 0; $y -lt $s; $y++) {
    $srcPtr = [IntPtr]::Add($d.Scan0, ($s - 1 - $y) * $d.Stride)
    [System.Runtime.InteropServices.Marshal]::Copy($srcPtr, $pix, 4 * $y * $s, 4 * $s)
  }
  $bmp.UnlockBits($d)
  $hdr = New-Object byte[] 40
  [Array]::Copy([BitConverter]::GetBytes([UInt32]40), 0, $hdr, 0, 4)
  [Array]::Copy([BitConverter]::GetBytes([Int32]$s), 0, $hdr, 4, 4)
  [Array]::Copy([BitConverter]::GetBytes([Int32](2 * $s)), 0, $hdr, 8, 4)
  [Array]::Copy([BitConverter]::GetBytes([UInt16]1), 0, $hdr, 12, 2)
  [Array]::Copy([BitConverter]::GetBytes([UInt16]32), 0, $hdr, 14, 2)
  [Array]::Copy([BitConverter]::GetBytes([UInt32]0), 0, $hdr, 16, 4)
  [Array]::Copy([BitConverter]::GetBytes([UInt32](4 * $s * $s)), 0, $hdr, 20, 4)
  $maskRow = [int]([Math]::Ceiling([Math]::Ceiling($s / 8.0) / 4.0) * 4)
  $out = New-Object byte[] (40 + $pix.Length + $maskRow * $s)
  [Array]::Copy($hdr, 0, $out, 0, 40)
  [Array]::Copy($pix, 0, $out, 40, $pix.Length)
  return ,$out
}

# ---- pack into .ico ----
$entries = @()
foreach ($s in @(16, 24, 32, 48, 64, 128, 256)) {
  $b = New-ClockBitmap $s
  if ($s -ge 256) {
    $ms2 = New-Object System.IO.MemoryStream
    $b.Save($ms2, [System.Drawing.Imaging.ImageFormat]::Png)
    $data = $ms2.ToArray(); $ms2.Close()
  } else {
    $data = ConvertTo-BmpEntry $b
  }
  $entries += ,@($s, $data)
  $b.Dispose()
}
$fs = [IO.File]::Create($Out)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
  $s = $e[0]; $data = $e[1]
  $wb = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([byte]$wb); $bw.Write([byte]$wb); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$data.Length); $bw.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($e in $entries) { $bw.Write([byte[]]$e[1]) }
$bw.Flush(); $bw.Close()
Write-Host "OK: $Out ($($entries.Count) sizes)"

# ---- previews for visual check ----
$p256 = New-ClockBitmap 256
$p256.Save("$env:TEMP\opencode\clock_preview256.png", [System.Drawing.Imaging.ImageFormat]::Png)
$p32 = New-ClockBitmap 32
$p32.Save("$env:TEMP\opencode\clock_preview32.png", [System.Drawing.Imaging.ImageFormat]::Png)
$p16 = New-ClockBitmap 16
$p16.Save("$env:TEMP\opencode\clock_preview16.png", [System.Drawing.Imaging.ImageFormat]::Png)
$p256.Dispose(); $p32.Dispose(); $p16.Dispose()
Write-Host "previews written to $env:TEMP\opencode"
