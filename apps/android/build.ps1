param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug",
    [switch]$RunTests,
    [switch]$RequireSigning
)

$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "setup.ps1")
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$configurationFile = Get-Content (Join-Path $PSScriptRoot "upstream.json") -Raw | ConvertFrom-Json
$checkoutPath = Join-Path $workspaceRoot $configurationFile.checkoutDirectory
$localJdk = Join-Path $workspaceRoot ".external\toolchains\jdk-21"
$localSdk = Join-Path $workspaceRoot ".external\android-sdk"
$toolchainLock = Get-Content (Join-Path $PSScriptRoot "windows-toolchain-lock.json") -Raw | ConvertFrom-Json

if (Test-Path (Join-Path $localJdk "bin\java.exe")) {
    $env:JAVA_HOME = $localJdk
}

$sdkPath = if (Test-Path $localSdk) {
    $localSdk
} elseif ($env:ANDROID_SDK_ROOT) {
    $env:ANDROID_SDK_ROOT
} else {
    $env:ANDROID_HOME
}

if (-not $sdkPath -or -not (Test-Path $sdkPath)) {
    throw "Android SDK introuvable. Installez-le localement ou définissez ANDROID_SDK_ROOT."
}

$env:ANDROID_SDK_ROOT = $sdkPath
$env:ANDROID_HOME = $sdkPath

$aapt2Root = Join-Path $workspaceRoot ".external\toolchains\aapt2-windows\$($toolchainLock.aapt2.version)"
$aapt2Archive = Join-Path $aapt2Root "aapt2-windows.jar"
$aapt2Path = Join-Path $aapt2Root "aapt2.exe"
New-Item -ItemType Directory -Force -Path $aapt2Root | Out-Null

if (-not (Test-Path $aapt2Archive)) {
    Invoke-WebRequest -Uri $toolchainLock.aapt2.url -OutFile $aapt2Archive -UseBasicParsing
}

$actualAapt2Hash = (Get-FileHash -LiteralPath $aapt2Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualAapt2Hash -ne $toolchainLock.aapt2.sha256) {
    throw "Le contrôle d'intégrité AAPT2 Windows a échoué."
}

if (-not (Test-Path $aapt2Path)) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($aapt2Archive)
    try {
        $entry = $archive.Entries | Where-Object { $_.FullName -eq "aapt2.exe" } | Select-Object -First 1
        if (-not $entry) { throw "L'archive AAPT2 ne contient pas aapt2.exe." }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $aapt2Path, $true)
    } finally {
        $archive.Dispose()
    }
}

$signingValues = @(
    $env:ANDROID_KEYSTORE_BASE64,
    $env:ANDROID_KEY_ALIAS,
    $env:ANDROID_KEYSTORE_PASSWORD,
    $env:ANDROID_KEY_PASSWORD,
    $env:BITCHAT_GITHUB_RELEASE_CERT_SHA256
)
$hasSigning = @($signingValues | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count -eq $signingValues.Count
if ($Configuration -eq "Release" -and $RequireSigning -and -not $hasSigning) {
    throw "La signature Android Release exige les cinq secrets documentés dans docs/RELEASING-PLATFORMS.md."
}

$variant = $Configuration.ToLowerInvariant()
$taskSuffix = $Configuration
$aapt2Override = "-Pandroid.aapt2FromMavenOverride=$aapt2Path"
$gradleTasks = @(
    if ($Configuration -eq "Debug") {
        "lintDebug"
        "assembleDebug"
    } else {
        "assembleRelease"
    }
)

& (Join-Path $checkoutPath "gradlew.bat") --project-dir $checkoutPath --no-daemon $aapt2Override @gradleTasks
if ($LASTEXITCODE -ne 0) { throw "La compilation Android $Configuration a échoué." }

$apkDirectory = Join-Path $checkoutPath "app\build\outputs\apk\$variant"
$apk = Get-ChildItem -LiteralPath $apkDirectory -Filter "*universal*$variant*.apk" -File -ErrorAction SilentlyContinue |
    Sort-Object Length -Descending |
    Select-Object -First 1
if (-not $apk) {
    throw "La compilation a réussi, mais aucun APK universel $Configuration n'a été trouvé."
}

$distPath = Join-Path $PSScriptRoot "dist"
New-Item -ItemType Directory -Force -Path $distPath | Out-Null

if ($Configuration -eq "Release" -and $hasSigning) {
    $apksigner = Get-ChildItem -LiteralPath (Join-Path $sdkPath "build-tools") -Filter "apksigner.bat" -File -Recurse |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if (-not $apksigner) { throw "apksigner.bat est absent du SDK Android." }

    $temporaryKeystore = Join-Path ([System.IO.Path]::GetTempPath()) "bitchat-android-$([guid]::NewGuid().ToString('N')).jks"
    try {
        [System.IO.File]::WriteAllBytes(
            $temporaryKeystore,
            [Convert]::FromBase64String($env:ANDROID_KEYSTORE_BASE64)
        )
        $outputApk = Join-Path $distPath "bitchat-release.apk"
        & $apksigner.FullName sign `
            --ks $temporaryKeystore `
            --ks-key-alias $env:ANDROID_KEY_ALIAS `
            --ks-pass "env:ANDROID_KEYSTORE_PASSWORD" `
            --key-pass "env:ANDROID_KEY_PASSWORD" `
            --out $outputApk `
            $apk.FullName
        if ($LASTEXITCODE -ne 0) { throw "La signature de l'APK Android a échoué." }
        $verificationOutput = @(& $apksigner.FullName verify --verbose --print-certs $outputApk 2>&1)
        $verificationExitCode = $LASTEXITCODE
        $verificationOutput | ForEach-Object { Write-Host $_ }
        if ($verificationExitCode -ne 0) { throw "La vérification de l'APK Android signé a échoué." }

        $certificateDigest = $null
        foreach ($line in $verificationOutput) {
            if ([string]$line -match 'certificate SHA-256 digest:\s*([0-9a-fA-F:]+)') {
                $certificateDigest = $Matches[1].Replace(":", "").ToLowerInvariant()
                break
            }
        }
        $expectedDigest = $env:BITCHAT_GITHUB_RELEASE_CERT_SHA256.Replace(":", "").ToLowerInvariant()
        if ($expectedDigest -notmatch '^[0-9a-f]{64}$' -or $certificateDigest -ne $expectedDigest) {
            throw "L'empreinte du certificat Android ne correspond pas à BITCHAT_GITHUB_RELEASE_CERT_SHA256."
        }
    } finally {
        if (Test-Path -LiteralPath $temporaryKeystore) {
            Remove-Item -LiteralPath $temporaryKeystore -Force
        }
    }
} else {
    $outputName = if ($Configuration -eq "Debug") {
        "bitchat-debug.apk"
    } else {
        "bitchat-release-unsigned.apk"
    }
    $outputApk = Join-Path $distPath $outputName
    Copy-Item -LiteralPath $apk.FullName -Destination $outputApk -Force
    if ($Configuration -eq "Release") {
        Write-Warning "APK Release non signé généré pour validation locale uniquement."
    }
}

$upstreamLicense = Join-Path $checkoutPath "LICENSE.md"
if (Test-Path -LiteralPath $upstreamLicense) {
    Copy-Item -LiteralPath $upstreamLicense -Destination (Join-Path $distPath "LICENSE-GPL-3.0.md") -Force
}

Write-Host "APK Android $Configuration généré : $outputApk"

if ($RunTests) {
    & (Join-Path $checkoutPath "gradlew.bat") --project-dir $checkoutPath --no-daemon $aapt2Override "test${taskSuffix}UnitTest"
    if ($LASTEXITCODE -ne 0) {
        throw "L'APK a été généré, mais des tests unitaires Android amont ont échoué."
    }
}
