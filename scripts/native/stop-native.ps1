# Stops the native SentinelStream stack (UI, API, Neo4j, MongoDB, Redis).
#   .\scripts\native\stop-native.ps1
param([string]$Root = "$env:USERPROFILE\SentinelNative")

. "$PSScriptRoot\common.ps1"
$ErrorActionPreference = 'Continue'
$tool = Resolve-Tools

function Stop-Matching($label, [scriptblock]$match) {
    Get-CimInstance Win32_Process | Where-Object $match | ForEach-Object {
        Write-Host "Stopping $label ($($_.Name) $($_.ProcessId))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

Stop-Matching 'UI'  { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'vite\.js.+preview' }
Stop-Matching 'API' { $_.Name -eq 'java.exe' -and $_.CommandLine -match 'sentinelstream-api' }

# The stores get a clean shutdown first so the AOF / WiredTiger journal / Neo4j
# store are flushed; anything still alive afterwards is killed.
if ((Test-Port 6379) -and $tool.RedisCli) { Write-Host 'Stopping Redis'; & $tool.RedisCli shutdown 2>$null | Out-Null }
if ((Test-Port 27017) -and $tool.Mongosh) {
    Write-Host 'Stopping MongoDB'
    # Single quotes inside the script: Windows PowerShell drops embedded double
    # quotes when it passes an argument to a native program.
    & $tool.Mongosh --quiet --eval "try { db.getSiblingDB('admin').shutdownServer({force:true}) } catch (e) {}" 2>$null | Out-Null
}
# mongod flushes and exits a few seconds after it acknowledges the shutdown.
for ($i = 0; $i -lt 20 -and ((Test-Port 6379) -or (Test-Port 27017)); $i++) { Start-Sleep 1 }
# Neo4j runs in console mode and has no clean remote stop; it replays its
# transaction log on the next start.
Stop-Matching 'leftover' { $_.ExecutablePath -and $_.ExecutablePath -like "$ext\*" }
Write-Host 'Stopped.'
