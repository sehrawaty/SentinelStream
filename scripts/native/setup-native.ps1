# SentinelStream -- one-time toolchain setup for Windows, no admin, no Docker.
# Downloads portable builds of everything CLAUDE.md §2 pins into $Root\ext,
# then installs npm dependencies and builds the API jar and the UI bundle.
# Re-runnable: a tool that is already unpacked is skipped.
#   .\scripts\native\setup-native.ps1
#   .\scripts\native\setup-native.ps1 -SkipBuild     # toolchain only
param([string]$Root = "$env:USERPROFILE\SentinelNative", [switch]$SkipBuild)

. "$PSScriptRoot\common.ps1"
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
$ProgressPreference = 'SilentlyContinue'
$dl = "$Root\dl"
New-Item -ItemType Directory -Force $ext, $dl, $data, $logs | Out-Null

# Dir = folder under ext\ ; Probe = file whose presence means "already installed".
# Sha = URL of a published SHA-256 (first token of the body), where one exists.
$tools = @(
    @{ Dir = 'jdk';     Probe = 'java.exe';         File = 'temurin-21.zip'
       Url = 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse' },
    @{ Dir = 'gradle';  Probe = 'gradle.bat';       File = 'gradle-8.8-bin.zip'
       Url = 'https://services.gradle.org/distributions/gradle-8.8-bin.zip'
       Sha = 'https://services.gradle.org/distributions/gradle-8.8-bin.zip.sha256' },
    @{ Dir = 'redis';   Probe = 'redis-server.exe'; File = 'Redis-7.2.16-Windows-x64-cygwin.zip'
       Url = 'https://github.com/redis-windows/redis-windows/releases/download/7.2.16/Redis-7.2.16-Windows-x64-cygwin.zip' },
    @{ Dir = 'mongodb'; Probe = 'mongod.exe';       File = 'mongodb-windows-x86_64-7.0.14.zip'
       Url = 'https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-7.0.14.zip'
       Sha = 'https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-7.0.14.zip.sha256' },
    @{ Dir = 'mongosh'; Probe = 'mongosh.exe';      File = 'mongosh-2.3.1-win32-x64.zip'
       Url = 'https://downloads.mongodb.com/compass/mongosh-2.3.1-win32-x64.zip' },
    @{ Dir = 'neo4j';   Probe = 'neo4j.bat';        File = 'neo4j-community-5.20.0-windows.zip'
       Url = 'https://dist.neo4j.org/neo4j-community-5.20.0-windows.zip' }
)

foreach ($t in $tools) {
    if (Find-Tool $t.Dir $t.Probe) { Write-Host "$($t.Dir): already installed"; continue }
    $zip = "$dl\$($t.File)"
    Write-Host "$($t.Dir): downloading $($t.File)..."
    # Resumable (-C -), and a transfer that stalls for 30s is aborted and retried
    # from where it stopped instead of hanging forever.
    & curl.exe -fsSL -C - --retry 20 --retry-all-errors --retry-delay 2 `
        --speed-limit 10000 --speed-time 30 -o $zip $t.Url
    if ($LASTEXITCODE -ne 0) { throw "download failed for $($t.Dir) ($($t.Url))" }

    if ($t.Sha) {
        $expected = ((& curl.exe -fsSL $t.Sha) -split '\s+')[0]
        $actual = (Get-FileHash $zip -Algorithm SHA256).Hash
        if ($expected -and $actual -ne $expected.ToUpper()) { throw "$($t.Dir): SHA-256 mismatch" }
        Write-Host "  sha256 verified"
    }

    New-Item -ItemType Directory -Force "$ext\$($t.Dir)" | Out-Null
    & tar.exe -xf $zip -C "$ext\$($t.Dir)"    # bsdtar reads zip; far faster than Expand-Archive
    if ($LASTEXITCODE -ne 0) { throw "extract failed for $($t.Dir)" }
    if (-not (Find-Tool $t.Dir $t.Probe)) { throw "$($t.Dir): $($t.Probe) not found after extract" }
    Remove-Item $zip -Force
    # MongoDB ships ~1.5 GB of debugger symbols next to its binaries.
    Get-ChildItem "$ext\$($t.Dir)" -Recurse -Filter *.pdb -File | Remove-Item -Force
}

if ($SkipBuild) { Write-Host 'Toolchain ready (build skipped).'; return }

$tool = Resolve-Tools
$env:JAVA_HOME = $tool.JavaHome
$env:PATH = "$($tool.JavaHome)\bin;$env:PATH"

Push-Location "$repo\api"
try {
    if (-not (Test-Path 'gradlew.bat')) {
        Write-Host 'api: generating Gradle 8.8 wrapper...'
        & $tool.Gradle wrapper --gradle-version 8.8 --no-daemon -q
        if ($LASTEXITCODE -ne 0) { throw 'gradle wrapper failed' }
    }
    Write-Host 'api: building jar...'
    & .\gradlew.bat bootJar --no-daemon -q -x test
    if ($LASTEXITCODE -ne 0) { throw 'api build failed' }
} finally { Pop-Location }

foreach ($dir in 'scripts', 'ui') {
    Write-Host "${dir}: npm ci..."
    Push-Location "$repo\$dir"
    try { & npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "npm ci failed in $dir" } }
    finally { Pop-Location }
}
Write-Host 'ui: building bundle...'
Push-Location "$repo\ui"
try { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'ui build failed' } } finally { Pop-Location }

Write-Host 'Setup complete. Next: .\scripts\native\start-native.ps1'
