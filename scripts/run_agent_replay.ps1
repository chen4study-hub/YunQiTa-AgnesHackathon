$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$env:PYTHONIOENCODING='utf-8'
$ErrorActionPreference='Continue'
& python -u -m scripts.export_agent_replay *> logs/agent_replay_export.log
exit $LASTEXITCODE
