# PLAN.md Part 7 -- "the five-second answer to 'is everything up'". Runs the
# graded path end to end (one create, one update, one delete, one
# aggregation, one explain, one ring check) and exits non-zero on failure.
# Run before the demo, not during it.
#   .\scripts\smoke.ps1
param([string]$Api = $(if ($env:API_BASE) { $env:API_BASE } else { 'http://localhost:8080' }))

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:fail = 0

function Step($name, [scriptblock]$check) {
    try {
        $detail = & $check
        Write-Host ("{0,-28}OK  {1}" -f $name, $detail)
    } catch {
        Write-Host ("{0,-28}FAIL  {1}" -f $name, $_.Exception.Message)
        $script:fail = 1
    }
}

function Call($method, $path, $body) {
    $req = @{ Method = $method; Uri = "$Api$path"; ContentType = 'application/json' }
    if ($body) { $req.Body = ($body | ConvertTo-Json -Compress) }
    Invoke-RestMethod @req
}

function New-Alert($cardId, $reason) {
    (Call POST '/api/alerts/manual' @{ cardId = $cardId; severity = 'LOW'; reason = $reason; author = 'smoke' }).alertId
}

Step 'health' {
    $h = Call GET '/api/health'
    if ($h.status -ne 'UP') { throw "status $($h.status)" }
}

Step 'create (manual alert)' {
    $script:alertId = New-Alert 'C-0001' 'smoke test create'
    if (-not $script:alertId) { throw 'no alertId in response' }
    "-> $script:alertId"
}

Step 'update (status transition)' {
    if (-not $script:alertId) { throw 'skipped -- no alert from create step' }
    $a = Call PATCH "/api/alerts/$script:alertId/status" @{ to = 'INVESTIGATING'; by = 'smoke' }
    if ($a.status -ne 'INVESTIGATING') { throw "status is $($a.status)" }
}

# A separate alert: INVESTIGATING is not delete-eligible (CLAUDE.md §4.5).
Step 'delete (dismiss)' {
    $id = New-Alert 'C-0002' 'smoke test delete'
    $d = Call DELETE "/api/alerts/${id}?reason=smoke+test&by=smoke"
    if (-not $d.dismissed) { throw 'not dismissed' }
}

Step 'aggregation (kpi facet)' {
    $k = Call GET '/api/stats/kpi?minutes=60'
    if ($null -eq $k.bySeverity -or $null -eq $k.byRule) { throw 'kpi response missing bySeverity/byRule' }
}

Step 'explain (index #10 live)' {
    $e = Call GET '/api/alerts/explain?status=NEW&severity=HIGH'
    if ($e.collScan -or -not $e.indexName) { throw "expected an index scan, got stages $($e.stages -join '>')" }
    "$($e.indexName), $($e.keysExamined) keys / $($e.docsExamined) docs"
}

Step 'ring (seeded C-9001)' {
    $r = Call GET '/api/rings/C-9001'
    if (-not $r.found) { throw 'RING_FOR_CARD found nothing -- run: node scripts/seed.mjs --wipe' }
    "$($r.cardNodes.Count) cards, $($r.queryMs)ms"
}

Write-Host ''
if ($script:fail -eq 0) { Write-Host 'All checks passed.' } else { Write-Host 'SMOKE TEST FAILED -- see above.' }
exit $script:fail
