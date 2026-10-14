param(
    [ValidateSet('dev', 'build', 'test', 'test:e2e', 'licenses', 'sync-replay')]
    [string]$Task = 'dev'
)
Set-Location $PSScriptRoot
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($npm) {
    & $npm.Source run $Task
    exit $LASTEXITCODE
}
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($node) {
    $nodePath = $node.Source
} else {
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    $candidates = Get-ChildItem "$local\OpenAI\Codex\runtimes\cua_node\*\bin\node.exe" -ErrorAction SilentlyContinue
    $nodePath = ($candidates | Select-Object -First 1).FullName
}
if (-not $nodePath -or -not (Test-Path '.tools/package/bin/npm-cli.js')) {
    Write-Error 'Node >=22.12 and npm are required.'
    exit 1
}
$env:PATH = (Split-Path $nodePath) + ';' + $env:PATH
& $nodePath '.tools/package/bin/npm-cli.js' run $Task
exit $LASTEXITCODE
