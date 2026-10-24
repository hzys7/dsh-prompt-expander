# Sync the canonical source into the desktop profile's installed copy.
#
# The profile holds a real directory (not a junction) so the host loads it like
# any other installed package. Host-side code changes only take effect after a
# DSH restart, so this script exists to make "source" and "what the host runs"
# identical before that restart.
#
#   powershell -NoProfile -File sync-to-profile.ps1
#   powershell -NoProfile -File sync-to-profile.ps1 -ProfileName web

param(
  [string]$ProfileName = 'desktop',
  [string]$DshHome = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($DshHome)) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $HOME '.dsh' }
}

$src = $PSScriptRoot

# Read the package name from the source manifest so a rename never desyncs this
# script from what the profile has installed.
$manifestPath = Join-Path $src 'package.json'
$manifest = [IO.File]::ReadAllText($manifestPath, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
$packageName = $manifest.name
if ([string]::IsNullOrEmpty($packageName)) {
  Write-Host "Could not read \"name\" from $manifestPath" -ForegroundColor Red
  exit 1
}

$dst = Join-Path $DshHome "profiles\$ProfileName\node_modules\$packageName"

if (-not (Test-Path -LiteralPath $dst -PathType Container)) {
  Write-Host "Installed copy not found: $dst" -ForegroundColor Red
  Write-Host "Install $packageName into the profile first."
  exit 1
}

# Only what the package ships; never node_modules or the packed tarball.
$rootFiles = @('package.json', 'cordis.patch.yml', 'README.md', 'LICENSE')
foreach ($name in $rootFiles) {
  $from = Join-Path $src $name
  if (Test-Path -LiteralPath $from -PathType Leaf) {
    Copy-Item -LiteralPath $from -Destination (Join-Path $dst $name) -Force
  }
}

$dstLib = Join-Path $dst 'lib'
if (-not (Test-Path -LiteralPath $dstLib -PathType Container)) {
  New-Item -ItemType Directory -Path $dstLib -Force | Out-Null
}
$libFiles = @(Get-ChildItem -LiteralPath (Join-Path $src 'lib') -File | Where-Object { $_.Extension -eq '.js' })
foreach ($file in $libFiles) {
  Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $dstLib $file.Name) -Force
}

# Prove the copy matches, because a silent mismatch is what makes the next
# restart look like "the fix did nothing".
$mismatch = @()
foreach ($name in $rootFiles) {
  $from = Join-Path $src $name
  if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { continue }
  $a = (Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash
  $b = (Get-FileHash -LiteralPath (Join-Path $dst $name) -Algorithm SHA256).Hash
  if ($a -ne $b) { $mismatch += $name }
}
foreach ($file in $libFiles) {
  $a = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
  $b = (Get-FileHash -LiteralPath (Join-Path $dstLib $file.Name) -Algorithm SHA256).Hash
  if ($a -ne $b) { $mismatch += ('lib/' + $file.Name) }
}

if ($mismatch.Count -gt 0) {
  Write-Host ('Sync verification FAILED for: ' + ($mismatch -join ', ')) -ForegroundColor Red
  exit 1
}

$count = @(Get-ChildItem -LiteralPath $dst -Recurse -File).Count
Write-Host "Synced to $dst"
Write-Host "Files: $count - all hashes match."
Write-Host 'Restart DSH for host-side changes to take effect.'
exit 0
