param(
    [switch]$RunTests,
    [switch]$RequireSigning
)

$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "build.ps1") `
    -Configuration Release `
    -RunTests:$RunTests `
    -RequireSigning:$RequireSigning
