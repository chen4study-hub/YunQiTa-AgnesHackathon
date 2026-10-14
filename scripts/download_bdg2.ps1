# Resumable BDG2 electricity download. Run from any directory with PowerShell 5.1.
# Raw data are ignored by Git; the partial file is kept on interruption.
param([int]$SliceSeconds = 60, [int]$MaxStalls = 20)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'data/raw/bdg2'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force $dir, $logDir | Out-Null
$url = 'https://media.githubusercontent.com/media/buds-lab/building-data-genome-project-2/master/data/meters/cleaned/electricity_cleaned.csv'
$part = Join-Path $dir 'electricity_cleaned.csv.part'
$dest = Join-Path $dir 'electricity_cleaned.csv'
$expectedBytes = 174977911
$expectedSha = 'b6ffc9b4dfcefe5c753594730a08ae822b0d50fec6815abb8f185591e6c630a3'
$log = Join-Path $logDir 'download_bdg2.log'
function Report([string]$message) {
    $line = ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message)
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
    Write-Output $line
}
if (Test-Path $dest) {
    $file = Get-Item $dest
    if ($file.Length -eq $expectedBytes -and (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower() -eq $expectedSha) {
        Report 'Already complete and verified.'
        exit 0
    }
    throw 'Existing final CSV failed verification; move it aside manually before retrying.'
}
$stalls = 0
while ($true) {
    $before = if (Test-Path $part) { (Get-Item $part).Length } else { 0 }
    if ($before -gt $expectedBytes) { throw 'Partial file exceeds expected size; not overwriting.' }
    if ($before -eq $expectedBytes) { break }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $ErrorActionPreference = 'Continue' # curl timeout is an expected, resumable outcome
    & curl.exe -L -C - --connect-timeout 15 --max-time $SliceSeconds -sS -o $part $url 2>> $log | Out-Null
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $watch.Stop()
    $after = if (Test-Path $part) { (Get-Item $part).Length } else { 0 }
    $delta = $after - $before
    $rate = if ($watch.Elapsed.TotalSeconds -gt 0) { [math]::Round($delta / 1MB / $watch.Elapsed.TotalSeconds, 3) } else { 0 }
    Report ("bytes=$after/$expectedBytes delta=$delta MiBps=$rate curl_exit=$code")
    if ($after -gt $expectedBytes) { throw 'Download exceeds expected size; refusing to finalize.' }
    if ($after -eq $expectedBytes) { break }
    if ($delta -le 0) { $stalls++ } else { $stalls = 0 }
    if ($stalls -ge $MaxStalls) { throw "Stopped after $stalls no-progress attempts; partial data retained." }
    Start-Sleep -Seconds ([math]::Min(30, 2 + 2 * $stalls))
}
$actualSha = (Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLower()
if ($actualSha -ne $expectedSha) { throw "SHA256 mismatch: $actualSha; partial file retained." }
Move-Item -LiteralPath $part -Destination $dest
Report "Verified complete SHA256=$actualSha path=$dest"
