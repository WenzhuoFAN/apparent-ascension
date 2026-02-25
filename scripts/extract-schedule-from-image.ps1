[CmdletBinding()]
param(
  [Parameter(Mandatory = $false, Position = 0)]
  [string]$ImagePath,
  [Parameter(Position = 1)]
  [int]$Year = 0,
  [Parameter(Position = 2)]
  [string]$WeekStart = "",
  [Parameter(Position = 3)]
  [string]$Out = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ocrScript = Join-Path $PSScriptRoot "ocr-win.ps1"
$parserScript = Join-Path $PSScriptRoot "extract-schedule-from-image.mjs"
$tmpDir = Join-Path $PSScriptRoot "_tmp"

if ([string]::IsNullOrWhiteSpace($ImagePath)) {
  throw "Missing image path. Usage: npm run extract:schedule:image -- <ImagePath> [Year] [WeekStart] [Out]"
}

New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$ocrJsonPath = Join-Path $tmpDir ("ocr-{0}.json" -f ([System.Guid]::NewGuid().ToString("N")))

try {
  # 1) OCR
  $ocrJson = & powershell -NoProfile -ExecutionPolicy Bypass -File $ocrScript -ImagePath $ImagePath
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($ocrJsonPath, $ocrJson, $utf8NoBom)

  # 2) Parse + generate schedule markdown
  $nodeArgs = @(
    $parserScript,
    "--ocr-json", $ocrJsonPath
  )

  if ($Year -gt 0) {
    $nodeArgs += @("--year", "$Year")
  }
  if (-not [string]::IsNullOrWhiteSpace($WeekStart)) {
    $nodeArgs += @("--week-start", $WeekStart)
  }
  if (-not [string]::IsNullOrWhiteSpace($Out)) {
    $nodeArgs += @("--out", $Out)
  }

  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Parser failed with exit code $LASTEXITCODE"
  }
}
finally {
  if (Test-Path -LiteralPath $ocrJsonPath) {
    Remove-Item -LiteralPath $ocrJsonPath -Force -ErrorAction SilentlyContinue
  }
}
