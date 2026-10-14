$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONPATH = (Join-Path $root '.experiment-deps') + ';' + $root
New-Item -ItemType Directory -Force logs | Out-Null
$ErrorActionPreference = 'Continue'
& python -u -m scripts.monthly_backtest *> logs/monthly_backtest.log
exit $LASTEXITCODE
