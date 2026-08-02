param(
    [string]$Version
)

$ErrorActionPreference = "Stop"
$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$packageDefinition = Get-Content (Join-Path $desktopRoot "package.json") -Raw | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = [string]$packageDefinition.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') {
    throw "Version d'installateur invalide : $Version"
}

$packagedApplication = Join-Path $desktopRoot "dist\bitchat-desktop-win32-x64\bitchat-desktop.exe"
if (-not (Test-Path -LiteralPath $packagedApplication)) {
    throw "Application portable absente. Exécutez d'abord npm run package:windows."
}

$compilerCandidates = @(
    (Get-Command ISCC.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
    (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
    (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$compiler = $compilerCandidates | Select-Object -First 1
if (-not $compiler) {
    throw "Inno Setup 6 est requis pour produire l'installateur Windows."
}

Push-Location $desktopRoot
try {
    & $compiler "/DAppVersion=$Version" (Join-Path $desktopRoot "installer.iss")
    if ($LASTEXITCODE -ne 0) { throw "La compilation de l'installateur Windows a échoué." }
} finally {
    Pop-Location
}

$installer = Join-Path $desktopRoot "dist\installer\bitchat-desktop-$Version-windows-x64-setup.exe"
if (-not (Test-Path -LiteralPath $installer)) {
    throw "Inno Setup n'a pas produit le fichier attendu : $installer"
}
Write-Host "Installateur Windows généré : $installer"
