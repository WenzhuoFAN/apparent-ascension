[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$Raw = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$cookieFile = Join-Path $repoRoot ".bili-cookie.txt"

if ([string]::IsNullOrWhiteSpace($Raw)) {
  try {
    $Raw = Get-Clipboard -Raw
  } catch {
    throw "No -Raw text provided and clipboard is unavailable. Copy a cURL command first."
  }
}

$cookie = $null
$patterns = @(
  "(?is)-b\s+[$]?'(?<cookie>(?:\\'|[^'])*)'",
  '(?is)-b\s+"(?<cookie>(?:\\"|[^"])*)"',
  "(?is)-H\s+'cookie:\s*(?<cookie>[^']+)'",
  '(?is)-H\s+"cookie:\s*(?<cookie>[^"]+)"'
)

foreach ($pattern in $patterns) {
  $m = [regex]::Match($Raw, $pattern)
  if ($m.Success) {
    $cookie = $m.Groups["cookie"].Value
    break
  }
}

if ($cookie) {
  $cookie = $cookie -replace "\\'", "'" -replace '\\"', '"'
}

if (-not $cookie) {
  throw "No cookie found in text. Copy a cURL command that includes -b or a cookie header."
}

$cookie = $cookie.Trim()
if ($cookie -notmatch "SESSDATA=" -or $cookie -notmatch "bili_jct=") {
  throw "Cookie is missing SESSDATA or bili_jct. Copy the dynamic API request cURL again."
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($cookieFile, $cookie, $utf8NoBom)

Write-Host "Saved cookie to: $cookieFile"
Write-Host "Next: npm run fetch:schedule:image -- 3493085336046382"
