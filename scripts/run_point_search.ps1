$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:PYTHONIOENCODING = 'utf-8'
New-Item -ItemType Directory -Force logs, '.experiment-deps' | Out-Null
# Local project-only dependency directory; does not upgrade the user's global Python.
# Native Python warnings on stderr are not PowerShell fatal exceptions.
$ErrorActionPreference = 'Continue'
if (-not ((Test-Path '.experiment-deps/xgboost/__init__.py') -and (Test-Path '.experiment-deps/catboost/__init__.py'))) {
    & python -m pip install --target '.experiment-deps' --no-deps xgboost catboost *> logs/point_install.log
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$env:PYTHONPATH = (Join-Path $root '.experiment-deps') + ';' + $root
& python -u -m scripts.point_search *> logs/point_search.log
exit $LASTEXITCODE
