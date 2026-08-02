param(
    [Parameter(Mandatory = $true)]
    [string[]]$Path,
    [switch]$RequireSigning
)

$ErrorActionPreference = "Stop"
$signingConfigured = -not [string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_BASE64) -and
    -not [string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PASSWORD)

if (-not $signingConfigured) {
    if ($RequireSigning) {
        throw "WINDOWS_CERTIFICATE_BASE64 et WINDOWS_CERTIFICATE_PASSWORD sont requis."
    }
    Write-Warning "Signature Windows non configurée : les fichiers restent non signés."
    return
}

$signTool = Get-ChildItem -LiteralPath "${env:ProgramFiles(x86)}\Windows Kits\10\bin" `
    -Filter signtool.exe -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
if (-not $signTool) { throw "signtool.exe x64 est introuvable dans le Windows SDK." }

$temporaryCertificate = Join-Path ([System.IO.Path]::GetTempPath()) "bitchat-windows-$([guid]::NewGuid().ToString('N')).pfx"
try {
    [System.IO.File]::WriteAllBytes(
        $temporaryCertificate,
        [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE_BASE64)
    )
    foreach ($candidate in $Path) {
        $resolvedPath = (Resolve-Path -LiteralPath $candidate).Path
        & $signTool.FullName sign /fd SHA256 /td SHA256 /tr "http://timestamp.digicert.com" `
            /f $temporaryCertificate /p $env:WINDOWS_CERTIFICATE_PASSWORD $resolvedPath
        if ($LASTEXITCODE -ne 0) { throw "La signature Windows a échoué : $resolvedPath" }

        & $signTool.FullName verify /pa /all $resolvedPath
        if ($LASTEXITCODE -ne 0) { throw "La vérification de signature a échoué : $resolvedPath" }
    }
} finally {
    if (Test-Path -LiteralPath $temporaryCertificate) {
        Remove-Item -LiteralPath $temporaryCertificate -Force
    }
}
