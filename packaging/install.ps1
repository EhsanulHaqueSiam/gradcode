# Installs the getmyprof command on Windows from its public releases. Needs only PowerShell 5.1.
#
#   irm https://github.com/EhsanulHaqueSiam/getmyprof/releases/latest/download/install.ps1 | iex
#
# A zip with its own Node, unpacked under %LOCALAPPDATA%\getmyprof\<version>, and getmyprof.cmd in
# %LOCALAPPDATA%\getmyprof\bin, which goes on your user PATH. The desktop app is the release's
# setup .exe (or .msi) instead.
#
#   GETMYPROF_VERSION      a version instead of the newest (0.3.1)
#   GETMYPROF_INSTALL_DIR  where versions unpack (%LOCALAPPDATA%\getmyprof)
#   GETMYPROF_RELEASE_URL  a mirror of the releases (https://github.com/<repo>/releases)
#
# Errors throw rather than exit: under `irm | iex` an exit would close the user's window.
$ErrorActionPreference = 'Stop'
# Windows PowerShell's progress bar slows Invoke-WebRequest to a crawl.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$repo = 'EhsanulHaqueSiam/getmyprof'
$releases = if ($env:GETMYPROF_RELEASE_URL) { $env:GETMYPROF_RELEASE_URL } else { "https://github.com/$repo/releases" }
$installDir = if ($env:GETMYPROF_INSTALL_DIR) { $env:GETMYPROF_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'getmyprof' }
$binDir = Join-Path $installDir 'bin'

$arch = switch ("$([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)") {
  'X64' { 'x64' }
  'Arm64' { 'arm64' }
  default { throw "getmyprof install: no build for $_" }
}

$version = $env:GETMYPROF_VERSION
if (-not $version) {
  # .../releases/latest redirects to .../releases/tag/v<version>.
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Head -TimeoutSec 30 "$releases/latest"
  } catch {
    throw "getmyprof install: can't reach $releases"
  }
  # Windows PowerShell answers with an HttpWebResponse, PowerShell 7 with an HttpResponseMessage.
  $final = if ($r.BaseResponse.ResponseUri) { $r.BaseResponse.ResponseUri } else { $r.BaseResponse.RequestMessage.RequestUri }
  $version = "$($final.AbsoluteUri)" -replace '^.*/v', ''
}
if ($version -notmatch '^\d+\.\d+\.\d+') { throw "getmyprof install: no release found at $releases" }

$stem = "getmyprof-$version-win32-$arch"
$tmp = Join-Path ([IO.Path]::GetTempPath()) "getmyprof-$([guid]::NewGuid())"
New-Item -ItemType Directory $tmp | Out-Null
try {
  $base = "$releases/download/v$version"
  try {
    Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS" -OutFile "$tmp\SHA256SUMS"
  } catch {
    throw "getmyprof install: release v$version has no SHA256SUMS"
  }
  Write-Host "Downloading $stem.zip"
  try {
    Invoke-WebRequest -UseBasicParsing "$base/$stem.zip" -OutFile "$tmp\$stem.zip"
  } catch {
    throw "getmyprof install: release v$version has no $stem.zip"
  }
  $line = Get-Content "$tmp\SHA256SUMS" | Where-Object { $_ -match "^[0-9a-f]{64}  $([regex]::Escape("$stem.zip"))$" } | Select-Object -First 1
  $actual = (Get-FileHash -Algorithm SHA256 "$tmp\$stem.zip").Hash
  # -ne compares without case: SHA256SUMS is lowercase, Get-FileHash uppercase.
  if (-not $line -or $line.Substring(0, 64) -ne $actual) { throw "getmyprof install: $stem.zip doesn't match SHA256SUMS" }

  Expand-Archive "$tmp\$stem.zip" -DestinationPath $tmp
  & "$tmp\$stem\getmyprof.cmd" --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "getmyprof install: the downloaded getmyprof doesn't run here" }

  New-Item -ItemType Directory -Force $installDir, $binDir | Out-Null
  $current = Join-Path $installDir 'current'
  $previous = if (Test-Path $current) { (Get-Content $current -Raw).Trim() } else { '' }
  $target = Join-Path $installDir $version
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Move-Item "$tmp\$stem" $target
  # Relative to bin, so the file stays ASCII whatever the user's folder is called.
  Set-Content -Encoding ASCII (Join-Path $binDir 'getmyprof.cmd') "@echo off`r`n`"%~dp0..\$version\node.exe`" `"%~dp0..\$version\cli.mjs`" %*`r`n"
  Set-Content -Encoding ASCII $current $version
  # Keep this version and the one before it (a background server may still run from it).
  Get-ChildItem -Directory $installDir |
    Where-Object { $_.Name -notin @('bin', $version, $previous) } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host "Installed getmyprof $version"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (("$userPath" -split ';') -contains $binDir) {
  Write-Host 'Run: getmyprof'
} else {
  [Environment]::SetEnvironmentVariable('Path', $(if ($userPath) { "$userPath;$binDir" } else { $binDir }), 'User')
  $env:Path = "$env:Path;$binDir"
  Write-Host "Added $binDir to your PATH. Run: getmyprof (a new terminal finds it too)"
}
