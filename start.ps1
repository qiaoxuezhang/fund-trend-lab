$ErrorActionPreference = "Stop"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
    $node = $nodeCommand.Source
} else {
    $node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
}
if (-not (Test-Path $node)) {
    Write-Error "未找到 Node.js。请安装 Node.js 20 或更高版本后运行 npm start。"
}
Set-Location $PSScriptRoot
& $node "server.mjs"
