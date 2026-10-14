$root = Split-Path -Parent $PSScriptRoot
$part = Join-Path $root 'data/raw/bdg2/electricity_cleaned.csv.part'
$final = Join-Path $root 'data/raw/bdg2/electricity_cleaned.csv'
$log = Join-Path $root 'logs/download_bdg2.log'
if (Test-Path $final) { $file = Get-Item $final; $state = 'verified file exists' }
elseif (Test-Path $part) { $file = Get-Item $part; $state = 'partial' }
else { $file = $null; $state = 'not started' }
$bytes = if ($file) { $file.Length } else { 0 }
Write-Output ("state=$state bytes=$bytes/174977911 percent=$([math]::Round(100*$bytes/174977911,2))")
schtasks.exe /Query /TN AgnesHackathon_BDG2Download /FO LIST /V 2>$null | Select-String 'Status:|Last Result:'
if (Test-Path $log) { Get-Content $log -Tail 3 }
