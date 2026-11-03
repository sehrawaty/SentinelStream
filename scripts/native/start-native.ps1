# SentinelStream -- starts the whole stack natively (no Docker): Redis,
# MongoDB (single-node rs0), Neo4j, the Spring Boot API and the UI.
# Idempotent: anything already listening on its port is left alone.
# Run setup-native.ps1 once first.
#   .\scripts\native\start-native.ps1              # everything
#   .\scripts\native\start-native.ps1 -DbOnly      # databases only
#   .\scripts\native\start-native.ps1 -Rebuild     # rebuild API jar + UI bundle first
#   .\scripts\native\start-native.ps1 -Fresh       # stop whatever is running, then start
#                                                  # on a wiped, reseeded demo state
# `run.cmd` in the project root is the short form of -Fresh.
param([switch]$DbOnly, [switch]$Rebuild, [switch]$Fresh, [string]$Root = "$env:USERPROFILE\SentinelNative")

. "$PSScriptRoot\common.ps1"
if ($Fresh) {
    Write-Host 'Stopping anything left from a previous run...'
    & "$PSScriptRoot\stop-native.ps1" -Root $Root
}
$tool = Resolve-Tools
foreach ($k in 'Java', 'Redis', 'Mongod', 'Mongosh', 'NeoHome') {
    if (-not $tool[$k]) { throw "$k not found under $ext -- run scripts\native\setup-native.ps1 first" }
}
$env:JAVA_HOME = $tool.JavaHome
$env:PATH = "$($tool.JavaHome)\bin;$env:PATH"
New-Item -ItemType Directory -Force "$data\redis", "$data\mongo", $logs | Out-Null

# -- Redis: AOF only, noeviction (CLAUDE.md §2) ------------------------------
if (-not (Test-Port 6379)) {
    Write-Host 'Starting Redis...'
    Set-Content "$data\redis\redis.conf" -Encoding ascii -Value @'
bind 127.0.0.1
port 6379
appendonly yes
appendfsync everysec
save ""
maxmemory 256mb
maxmemory-policy noeviction
'@
    Start-Process $tool.Redis -ArgumentList 'redis.conf' -WorkingDirectory "$data\redis" -WindowStyle Hidden `
        -RedirectStandardOutput "$logs\redis.out.log" -RedirectStandardError "$logs\redis.err.log"
    Wait-Port 6379 Redis
} else { Write-Host 'Redis already running' }

# -- MongoDB: single-node replica set rs0 ------------------------------------
if (-not (Test-Port 27017)) {
    Write-Host 'Starting MongoDB...'
    Start-Process $tool.Mongod -WindowStyle Hidden -ArgumentList @(
        '--replSet', 'rs0', '--bind_ip', '127.0.0.1', '--dbpath', "`"$data\mongo`"",
        '--wiredTigerCacheSizeGB', '0.25', '--logpath', "`"$logs\mongod.log`"", '--logappend')
    Wait-Port 27017 MongoDB
} else { Write-Host 'MongoDB already running' }
& $tool.Mongosh --quiet --eval "try { rs.status().ok } catch (e) { rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]}).ok }" | Out-Null
$primary = $false
for ($i = 0; $i -lt 30 -and -not $primary; $i++) {
    $primary = (& $tool.Mongosh --quiet --eval 'db.hello().isWritablePrimary') -match 'true'
    if (-not $primary) { Start-Sleep 1 }
}
if (-not $primary) { throw 'MongoDB did not become PRIMARY of rs0' }
Write-Host '  rs0 PRIMARY'

# -- Neo4j: memory + password applied once, on first start -------------------
$neo = $tool.NeoHome
if (-not (Test-Path "$neo\data\.sentinel-initialised")) {
    Add-Content "$neo\conf\neo4j.conf" -Encoding ascii -Value @'

# SentinelStream (CLAUDE.md section 2)
server.memory.heap.initial_size=256m
server.memory.heap.max_size=384m
server.memory.pagecache.size=128m
dbms.usage_report.enabled=false
'@
    & "$neo\bin\neo4j-admin.bat" dbms set-initial-password sentinel-dev | Out-Null
    New-Item -ItemType Directory -Force "$neo\data" | Out-Null
    New-Item -ItemType File -Force "$neo\data\.sentinel-initialised" | Out-Null
}
if (-not (Test-Port 7687)) {
    Write-Host 'Starting Neo4j...'
    Start-Process "$neo\bin\neo4j.bat" -ArgumentList 'console' -WindowStyle Hidden `
        -RedirectStandardOutput "$logs\neo4j.out.log" -RedirectStandardError "$logs\neo4j.err.log"
    Wait-Port 7687 Neo4j 180
} else { Write-Host 'Neo4j already running' }

# -- Fresh: wipe and reseed before the API boots, so its generator, counters and
#    consumer group all start from the seeded state and nothing from the last
#    run is carried over. seed.mjs talks to the stores directly when the API is down.
if ($Fresh) {
    Write-Host 'Resetting to the seeded demo state...'
    Push-Location "$repo\scripts"
    try {
        if (-not (Test-Path 'node_modules')) { & npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed in scripts' } }
        & node seed.mjs --wipe
        if ($LASTEXITCODE -ne 0) { throw 'seed.mjs failed -- see its output above' }
    } finally { Pop-Location }
}

if ($DbOnly) { Write-Host 'Databases up.'; return }

# -- API: run the boot jar directly (bootRun would keep a Gradle JVM alive) ---
function Get-ApiJar {
    Get-ChildItem "$repo\api\build\libs\*.jar" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike '*-plain.jar' } | Select-Object -First 1 -ExpandProperty FullName
}
if (Test-Port 8080) { Write-Host 'API already running on :8080' }
else {
    if ($Rebuild -or -not (Get-ApiJar)) {
        Write-Host 'Building API jar...'
        Push-Location "$repo\api"
        try { & .\gradlew.bat bootJar --no-daemon -q -x test; if ($LASTEXITCODE -ne 0) { throw 'api build failed' } }
        finally { Pop-Location }
    }
    Write-Host 'Starting API...'
    $env:SERVER_ADDRESS = '127.0.0.1'
    Start-Process $tool.Java -WindowStyle Hidden -WorkingDirectory "$repo\api" `
        -ArgumentList '-Xmx384m', '-jar', "`"$(Get-ApiJar)`"" `
        -RedirectStandardOutput "$logs\api.out.log" -RedirectStandardError "$logs\api.err.log"
    Wait-Port 8080 API 180
}

# -- UI: production bundle behind `vite preview`, which proxies /api and /ws --
if (Test-Port 3000) { Write-Host 'UI already running on :3000' }
else {
    Push-Location "$repo\ui"
    try {
        if (-not (Test-Path 'node_modules')) { & npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' } }
        if ($Rebuild -or -not (Test-Path 'dist\index.html')) {
            Write-Host 'Building UI...'
            & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'ui build failed' }
        }
    } finally { Pop-Location }
    Write-Host 'Starting UI...'
    Start-Process (Get-Command node).Source -WindowStyle Hidden -WorkingDirectory "$repo\ui" `
        -ArgumentList 'node_modules\vite\bin\vite.js', 'preview' `
        -RedirectStandardOutput "$logs\ui.out.log" -RedirectStandardError "$logs\ui.err.log"
    Wait-Port 3000 UI 60
}

Write-Host ''
Write-Host 'SentinelStream is up:'
Write-Host '  Dashboard      http://localhost:3000'
Write-Host '  API health     http://localhost:8080/api/health'
Write-Host '  Neo4j Browser  http://localhost:7474   (neo4j / sentinel-dev)'
Write-Host "  Logs           $logs"
