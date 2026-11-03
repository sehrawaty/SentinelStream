# Shared by setup-native / start-native / stop-native: where the portable
# toolchain lives and how to find each tool without hardcoding its version.
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = "$env:USERPROFILE\SentinelNative" }
$ext  = "$Root\ext"
$data = "$Root\data"
$logs = "$Root\logs"
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path

# Node ships an installer that only updates PATH for new logins.
if (-not (Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path 'C:\Program Files\nodejs\node.exe')) {
    $env:PATH = "C:\Program Files\nodejs;$env:PATH"
}

# First file matching $Filter anywhere under ext\$Dir, or $null.
function Find-Tool($Dir, $Filter) {
    if (-not (Test-Path "$ext\$Dir")) { return $null }
    Get-ChildItem "$ext\$Dir" -Recurse -Filter $Filter -File -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}

function Resolve-Tools {
    $javaExe = Find-Tool 'jdk' 'java.exe'
    $neoBat  = Find-Tool 'neo4j' 'neo4j.bat'
    @{
        JavaHome   = if ($javaExe) { Split-Path (Split-Path $javaExe) } else { $null }
        Java       = $javaExe
        Gradle     = Find-Tool 'gradle' 'gradle.bat'
        Redis      = Find-Tool 'redis' 'redis-server.exe'
        RedisCli   = Find-Tool 'redis' 'redis-cli.exe'
        Mongod     = Find-Tool 'mongodb' 'mongod.exe'
        Mongosh    = Find-Tool 'mongosh' 'mongosh.exe'
        NeoHome    = if ($neoBat) { Split-Path (Split-Path $neoBat) } else { $null }
    }
}

function Test-Port($p) {
    $c = New-Object Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $p); $true } catch { $false } finally { $c.Close() }
}

function Wait-Port($p, $name, $sec = 90) {
    for ($i = 0; $i -lt $sec; $i++) {
        if (Test-Port $p) { Write-Host "  $name up on :$p"; return }
        Start-Sleep 1
    }
    throw "$name did not open :$p within ${sec}s (see $logs)"
}
