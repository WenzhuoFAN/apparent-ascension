[CmdletBinding()]
param(
  [Parameter(Mandatory = $false, Position = 0)]
  [string]$Mid = "3493085336046382",
  [Parameter(Mandatory = $false, Position = 1)]
  [int]$Year = 0,
  [Parameter(Mandatory = $false, Position = 2)]
  [string]$WeekStart = "",
  [Parameter(Mandatory = $false, Position = 3)]
  [string]$Out = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$fetchScript = Join-Path $PSScriptRoot "fetch-pinned-schedule-image.mjs"
$extractScript = Join-Path $PSScriptRoot "extract-schedule-from-image.ps1"
$tmpDir = Join-Path $PSScriptRoot "_tmp"
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

$fetchJsonPath = Join-Path $tmpDir ("fetch-result-{0}.json" -f ([System.Guid]::NewGuid().ToString("N")))

try {
  $fetchArgs = @(
    $fetchScript,
    "--mid", $Mid,
    "--json"
  )
  $fetchJson = & node @fetchArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to fetch pinned schedule image, exit code: $LASTEXITCODE"
  }

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($fetchJsonPath, $fetchJson, $utf8NoBom)
  $fetchResult = Get-Content -LiteralPath $fetchJsonPath -Raw | ConvertFrom-Json

  if (-not $fetchResult.primaryImage) {
    throw "No primary image returned from fetch script."
  }

  Write-Host ("Fetched image: {0}" -f $fetchResult.primaryImage)

  $extractArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $extractScript,
    $fetchResult.primaryImage
  )
  if ($Year -gt 0) {
    $extractArgs += $Year
  }
  if (-not [string]::IsNullOrWhiteSpace($WeekStart)) {
    $extractArgs += $WeekStart
  }
  if (-not [string]::IsNullOrWhiteSpace($Out)) {
    $extractArgs += $Out
  }

  & powershell @extractArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to extract schedule from image, exit code: $LASTEXITCODE"
  }
}
finally {
  if (Test-Path -LiteralPath $fetchJsonPath) {
    Remove-Item -LiteralPath $fetchJsonPath -Force -ErrorAction SilentlyContinue
  }
}
