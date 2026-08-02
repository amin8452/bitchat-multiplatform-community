param([switch]$RunTests)

$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "build.ps1") -Configuration Debug -RunTests:$RunTests
