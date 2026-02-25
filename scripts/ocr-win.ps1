[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ImagePath,
  [string]$Language = "zh-Hans-CN"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null

function Await-WinRt {
  param(
    [Parameter(Mandatory = $true)]
    [object]$WinRtTask,
    [Parameter(Mandatory = $true)]
    [Type]$ResultType
  )
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1

  if (-not $asTask) {
    throw "Cannot locate WindowsRuntimeSystemExtensions.AsTask<T>."
  }

  $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $task.Wait()
  return $task.Result
}

if (-not (Test-Path -LiteralPath $ImagePath -PathType Leaf)) {
  throw "Image not found: $ImagePath"
}

$resolvedPath = (Resolve-Path -LiteralPath $ImagePath).Path

$file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($resolvedPath)) ([Windows.Storage.StorageFile])
$stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])

$ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Language))
if (-not $ocrEngine) {
  $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if (-not $ocrEngine) {
  throw "OCR engine unavailable. Install OCR language packs first."
}

$result = Await-WinRt ($ocrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$lineObjects = @()
foreach ($line in $result.Lines) {
  $words = @($line.Words)
  if ($words.Count -eq 0) { continue }

  $minX = [double]::PositiveInfinity
  $minY = [double]::PositiveInfinity
  $maxX = [double]::NegativeInfinity
  $maxY = [double]::NegativeInfinity

  $wordObjects = @()
  foreach ($word in $words) {
    $rect = $word.BoundingRect
    $x = [double]$rect.X
    $y = [double]$rect.Y
    $w = [double]$rect.Width
    $h = [double]$rect.Height

    $minX = [Math]::Min($minX, $x)
    $minY = [Math]::Min($minY, $y)
    $maxX = [Math]::Max($maxX, $x + $w)
    $maxY = [Math]::Max($maxY, $y + $h)

    $wordObjects += [pscustomobject]@{
      text   = $word.Text
      x      = [int][Math]::Round($x)
      y      = [int][Math]::Round($y)
      width  = [int][Math]::Round($w)
      height = [int][Math]::Round($h)
    }
  }

  $lineObjects += [pscustomobject]@{
    text   = $line.Text
    x      = [int][Math]::Round($minX)
    y      = [int][Math]::Round($minY)
    width  = [int][Math]::Round($maxX - $minX)
    height = [int][Math]::Round($maxY - $minY)
    words  = $wordObjects
  }
}

$output = [pscustomobject]@{
  engineLanguage = $ocrEngine.RecognizerLanguage.LanguageTag
  image          = [pscustomobject]@{
    path   = $resolvedPath
    width  = [int]$bitmap.PixelWidth
    height = [int]$bitmap.PixelHeight
  }
  text           = $result.Text
  lines          = $lineObjects
}

$output | ConvertTo-Json -Depth 8
