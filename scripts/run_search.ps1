$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:PYTHONIOENCODING = 'utf-8'
New-Item -ItemType Directory -Force logs | Out-Null
& python -u -m scripts.search_byron *> logs/byron_search.log
exit $LASTEXITCODE
