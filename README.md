# SentinelStream

Real-time card fraud detection over polyglot NoSQL persistence: Redis Streams,
MongoDB and Neo4j behind a Spring Boot API and a React dashboard. It runs
natively on Windows, without Docker.

Course project. `docs/NoSQL_Project.md` is the design spec; `CLAUDE.md` is the
implementation reference (data models, indexes, consumer ordering, decision
log) and wins where the two disagree.

## What it does

A generator emits about 150 synthetic card transactions a second onto a Redis
Stream. A consumer group scores each one against four rules using sliding
windows held in Redis, writes transactions and alerts to MongoDB, and projects
cards, devices and IPs into a Neo4j graph. When Redis notices one device behind
three or more cards, Neo4j resolves the whole fraud ring in a single traversal.

| Store | Job | Why this model |
|---|---|---|
| Redis | Ordered ingestion (Streams, consumer group) and per-card sliding windows (ZSet, GEO) | Window reads are O(1) or O(log N); delivery is at-least-once with redelivery |
| MongoDB | Transactions, alerts with per-rule evidence, triage workflow, aggregations | Each rule's evidence has a different shape; alerts are documents, not rows |
| Neo4j | Cards linked to the devices and IPs they use | A ring is a variable-depth traversal, not a recursive join |

## Requirements

- Windows 10 or 11, PowerShell 5.1
- Node.js 20.14 or newer
- About 2 GB of disk (1.2 GB of tools, the rest data) and 1 GB of free RAM
- No administrator rights, no Docker

## Run it

After the one-time setup below, two commands from the project folder are all
you need:

```powershell
.\run     # stop any previous run, start everything on freshly seeded data, open the dashboard
.\stop    # stop everything
```

`.\run` takes about two minutes. It always starts clean: nothing from the last
session is carried over. `.\run -Rebuild` also rebuilds the API and the UI
first; use it after changing code. (In the old `cmd` prompt, type `run` and
`stop` without the `.\`.)

The same steps one at a time, if you want to keep data between runs:

```powershell
# Once: downloads portable JDK 21, Gradle 8.8, Redis 7.2, MongoDB 7.0, mongosh and
# Neo4j 5.20 into %USERPROFILE%\SentinelNative, then builds the API jar and the UI.
powershell -ExecutionPolicy Bypass -File scripts\native\setup-native.ps1

# Redis, MongoDB (rs0), Neo4j, API and UI, keeping existing data. Safe to re-run.
powershell -ExecutionPolicy Bypass -File scripts\native\start-native.ps1

# Load the deterministic demo state (about 15 seconds).
cd scripts
node seed.mjs --wipe
cd ..

# Check the graded path end to end.
powershell -ExecutionPolicy Bypass -File scripts\smoke.ps1

# When finished.
powershell -ExecutionPolicy Bypass -File scripts\native\stop-native.ps1
```

| | |
|---|---|
| Dashboard | http://localhost:3000 |
| API health | http://localhost:8080/api/health |
| Neo4j Browser | http://localhost:7474 (`neo4j` / `sentinel-dev`) |
| MongoDB | `mongodb://localhost:27017/sentinel?replicaSet=rs0&directConnection=true` |
| Redis | `redis://localhost:6379` |
| Logs | `%USERPROFILE%\SentinelNative\logs` |
| Data | `%USERPROFILE%\SentinelNative\data` |

`start-native.ps1 -DbOnly` starts only the three databases.
`start-native.ps1 -Rebuild` rebuilds the jar and the UI bundle first; use it
after changing code. For UI work, `cd ui; npm run dev` serves a hot-reloading
copy on port 5173 against the same API.

Nothing runs in the background once `stop-native.ps1` has finished. To remove
everything, delete `%USERPROFILE%\SentinelNative`.

## The dashboard

| View | What it shows | What it demonstrates |
|---|---|---|
| Live monitor | KPI tiles, the live settlement tape, the alert feed, and four fraud patterns to inject | Redis Streams, the four detectors, the three STOMP channels |
| Triage | Filterable, paged alert queue with the live query plan; case drawer with evidence, notes, status, assignment; raise, dismiss and bulk dismiss; blocked cards | MongoDB create, read, update and delete; index #10; the `$lookup` pipeline; the Mongo to Redis block-card write |
| Fraud rings | Interactive graph for any card, the Cypher behind it, ring history, most-shared devices and IPs | The Neo4j traversal and the Redis to Neo4j handoff |
| Analytics | Alerts by severity, fraud rate by category, detector activity, score bands, watchlist | Aggregation pipelines A to D, each labelled with its stages |
| Data stores | Live figures from each store and the index registry | What each database holds, and the 16 declared indexes |

### A five-minute demo

1. **Live monitor.** Traffic is flowing at about 150 a second. Point at the tape.
2. **Inject a velocity burst.** One card, 12 transactions in 20 seconds. A
   medium alert appears in the feed from the fifth transaction on.
3. **Inject impossible travel.** Chennai, then Delhi two seconds later. Open the
   alert: the evidence shows the distance, the gap and the implied speed.
4. **Inject a fraud ring.** Six cards start sharing one device. Fan-out fires
   from the third card, and a notice appears when Neo4j has resolved the group.
   Choose **View ring**.
5. **Fraud rings.** Open the seeded ring `C-9001` for the clean six-card picture,
   show the Cypher, then run the same query in Neo4j Browser.
6. **Triage.** Filter to New and High. The query plan line shows `IXSCAN` on
   `status_1_severity_1_ts_-1` with keys examined equal to documents returned.
   Open an alert, start investigating, add a note, and block the card.
7. **Back on the live monitor**, that card's next transactions are struck through
   and marked Declined: a MongoDB write that changed the live stream through Redis.

A ring injected into live traffic can come back larger than six cards, because
every organic device and IP is legitimately shared by two cards and the
traversal follows them. The seeded ring is isolated and always shows exactly
six. See `CLAUDE.md` §8 D-31.

## API

| | |
|---|---|
| `GET /api/health` | Per-store status |
| `GET /api/alerts` | Queue: `status`, `severity`, `cardId`, `rule`, `page`, `size` |
| `GET /api/alerts/explain` | Live query plan for a `status` and `severity` filter |
| `GET /api/alerts/{id}` | Alert with its transaction, prior transactions and block status |
| `POST /api/alerts/manual` | Raise a case |
| `PATCH /api/alerts/{id}/status` · `/assign` | Move through the lifecycle; assign |
| `POST` · `PATCH` · `DELETE /api/alerts/{id}/notes[/{noteId}]` | Notes |
| `DELETE /api/alerts/{id}` · `DELETE /api/alerts?status=` | Dismiss one; dismiss all in a status |
| `GET /api/cards/blocked` · `POST` · `DELETE /api/cards/{id}/block` | Blocklist |
| `GET /api/txns?cardId=` | Transaction history |
| `GET /api/rings/{cardId}` · `/api/rings` · `/api/rings/snapshots` | Ring for a card; shared entities; history |
| `GET /api/stats/kpi` · `/throughput` · `/fraud-by-category` · `/severity-timeline` · `/top-cards` | Aggregations and the ingest rate |
| `POST /api/control/inject/velocity` · `/amount` · `/travel` · `/ring` | Fraud patterns |
| `POST /api/control/generator/pause` · `/resume` | Background traffic |
| `GET /api/admin/indexes` · `/mongo-stats` · `/redis-stats` · `/neo4j-stats` | Store internals |

STOMP endpoint `/ws`: `/topic/txn` (sampled to about 8 a second, flagged rows
always sent), `/topic/alerts` (every alert, full document), `/topic/rings`
(each ring as it is resolved).

## Detection rules

| Rule | Fires when | Weight |
|---|---|---|
| Velocity | 5 or more transactions on a card in 60 s | 40 |
| Amount anomaly | Amount above mean + 3σ of the card's last 20 (at least 5) | 25 |
| Impossible travel | Implied speed above 900 km/h over at least 200 km | 70 |
| Entity fan-out | One device or IP used by 3 or more cards in 600 s | 55 |

The score is the sum of the weights, capped at 100. Low is 1 to 39, medium 40
to 69, high 70 and above. Thresholds live in `api/src/main/resources/application.yml`.

## Index evidence

`docs/evidence/explain-report.md` holds captured before and after `explain()`
plans for six probe queries. Regenerate it with
`node scripts/explain-evidence.mjs` from `scripts/`. The Triage view shows the
same thing live for whatever filter is selected.

## Presenting it

- `docs/Teacher_demo.md` explains every component, gives a step-by-step demo
  script, and answers the likely questions.
- `docs/presentation/` holds the material for a slide deck: the content
  (`SentinelStream_PPT_content.md`), six diagrams, thirteen screenshots of the
  running system, and a prompt for generating the deck (`PPT_prompt.md`).

## Troubleshooting

- **A port is already in use.** `start-native.ps1` leaves anything already
  listening alone. Run `stop-native.ps1` first for a clean start.
- **The dashboard says the API is not responding.** Read
  `%USERPROFILE%\SentinelNative\logs\api.out.log`. The API takes about 15
  seconds to start.
- **The alert detail shows no triggering transaction.** Raw transactions expire
  after 24 hours by design. Re-run `node seed.mjs --wipe`.
- **Neo4j runs out of memory.** Lower `server.memory.heap.max_size` in
  `ext\neo4j\...\conf\neo4j.conf`. Do not raise it.
- **The amount-anomaly injector answers 409.** The rule needs five earlier
  payments on a card. Let traffic run for two minutes after a cold start.
