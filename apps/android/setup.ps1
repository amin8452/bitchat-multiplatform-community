$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$configuration = Get-Content (Join-Path $PSScriptRoot "upstream.json") -Raw | ConvertFrom-Json
$checkoutPath = Join-Path $workspaceRoot $configuration.checkoutDirectory
$checkoutParent = Split-Path $checkoutPath -Parent

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git est requis pour préparer le client Android."
}

$submoduleEntry = if (Test-Path (Join-Path $workspaceRoot ".git")) {
    & git -C $workspaceRoot ls-files --stage -- $configuration.checkoutDirectory 2>$null
} else {
    $null
}
$isRegisteredSubmodule = [string]$submoduleEntry -match '^160000\s'
$checkoutIsGitRepository = Test-Path (Join-Path $checkoutPath ".git")

if ($isRegisteredSubmodule -and -not $checkoutIsGitRepository) {
    & git -C $workspaceRoot submodule update --init --depth 1 --checkout -- $configuration.checkoutDirectory
    if ($LASTEXITCODE -ne 0) {
        throw "Le sous-module Android officiel n'a pas pu être initialisé."
    }
}

if (-not (Test-Path $checkoutPath)) {
    New-Item -ItemType Directory -Force -Path $checkoutParent | Out-Null
    New-Item -ItemType Directory -Force -Path $checkoutPath | Out-Null
    & git -C $checkoutPath init
    if ($LASTEXITCODE -ne 0) { throw "L'initialisation du client Android a échoué." }
    & git -C $checkoutPath remote add origin $configuration.repository
    if ($LASTEXITCODE -ne 0) { throw "La source du client Android n'a pas pu être configurée." }
} elseif (-not (Test-Path (Join-Path $checkoutPath ".git"))) {
    throw "Le chemin $checkoutPath existe mais ne contient pas le dépôt Android attendu."
}

$configuredOrigin = (& git -C $checkoutPath remote get-url origin 2>$null).Trim()
if (-not $configuredOrigin) {
    & git -C $checkoutPath remote add origin $configuration.repository
} elseif ($configuredOrigin -ne $configuration.repository) {
    throw "Le checkout Android pointe vers une source inattendue : $configuredOrigin"
}

$previousErrorPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$currentCommitOutput = & git -C $checkoutPath rev-parse --verify HEAD 2>$null
$hasCurrentCommit = $LASTEXITCODE -eq 0
$ErrorActionPreference = $previousErrorPreference
$currentCommit = if ($hasCurrentCommit) { $currentCommitOutput.Trim() } else { "" }
$changes = & git -C $checkoutPath status --porcelain
if ($changes -and $currentCommit -ne $configuration.commit) {
    throw "Le client Android contient des modifications locales. Aucun fichier ne sera écrasé."
}

if ($currentCommit -ne $configuration.commit) {
    & git -C $checkoutPath fetch --depth 1 origin $configuration.commit
    if ($LASTEXITCODE -ne 0) { throw "Impossible de récupérer la révision Android épinglée." }
    & git -C $checkoutPath switch --detach $configuration.commit
    if ($LASTEXITCODE -ne 0) { throw "Impossible d'activer la révision Android épinglée." }
}

Write-Host "Client Android prêt : $checkoutPath"
Write-Host "Révision : $($configuration.commit)"
