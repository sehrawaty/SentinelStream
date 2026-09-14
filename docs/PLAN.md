# SentinelStream — Implementation Plan

## Context

`NoSQL_Project.md` is a strong systems design document, but it was written to argue
for polyglot persistence, not to satisfy a marking rubric. The project is graded on
**System Design, Database Implementation, Query Quality**, and the examiner must see
live: all four CRUD operations on MongoDB driven from the UI, explicit indexes with
before/after `explain()` evidence, and non-trivial aggregation pipelines.

The spec serves Create and Read well (the consumer writes transactions and alerts;
the dashboard reads them) and serves the other rubrics barely at all:

- **Update** appears nowhere. No document is ever modified after insert.
- **Delete** appears nowhere, except implicitly via Redis stream trimming — which is
  not MongoDB and not analyst-driven.
- **Aggregation** is named exactly once, in §8 S11 ("KPI aggregations"), with no
  pipeline specified.
- **Indexes** are mentioned twice in passing (§3 `{severity, ts}`, §10 viva
  `{cardId: 1, ts: -1}`), never registered, and no `explain()` evidence is planned.
- **Sequencing is inverted**: §8 puts all MongoDB work in Week 4 (S11), *after* Neo4j
  and the UI. The graded material is scheduled into the slice §12 designates as "the
  designated cut". If the schedule slips, exactly the rubric-bearing work is lost.

This plan closes those gaps as first-class features. The central addition is an
**alert triage workflow** — an analyst working a case queue — which is not
decoration: it is the natural home for Update (status lifecycle, investigator notes)
and Delete (dismissing false positives), and it makes both demonstrable from the UI
rather than from `mongosh`. It also closes a loop the spec leaves open: an analyst
blocking a card writes back to a Redis blocklist that the hot path enforces, so a
MongoDB write visibly changes live stream behaviour. That single flow touches all
three stores and is the strongest System Design moment in the project after the ring
handoff.

The build order is resequenced so every graded operation is complete and demo-ready
before any Neo4j or UI polish begins.

**Deliverable #1 is `CLAUDE.md`. No application code is written until it exists.**

---

## Part 0 — Spec inconsistencies and their resolutions

Seven found. Two were flagged by you; five were not. Each is resolved here, and the
resolution is recorded in CLAUDE.md §8 so it does not drift.

### I-1 · Throughput figure *(you flagged this)*
§1 and the §4 diagram say `~150 txn/s`. The §7.4 layout mock shows `1,284 txn/s`.

**Resolution:** 150 txn/s is authoritative. The mock is placeholder lorem. The KPI
strip renders the live measured rate; at rest it reads ~150. Mock corrected to
`148 txn/s ↑`. Also note the KPI strip's `14 alerts` should be a live count, not a
constant.

### I-2 · Velocity injector count *(you flagged this)*
§5: "one card, 12 transactions in 20 seconds". §9 step 2: "Five transactions in
sixty seconds".

**Resolution:** These are two different things that the spec conflated — the
*injector* and the *detector threshold*. Both survive, stated separately:

- Detector threshold: `VELOCITY` fires at **≥5 transactions in a 60s window**.
- Injector: **12 transactions in 20 seconds**, which clears the threshold decisively
  and fires fast enough to narrate on stage.
- Demo narration becomes: *"Twelve transactions in twenty seconds. The rule is five
  in sixty — that's a Redis sorted set trimmed by timestamp, O(1) to read the count."*

### I-3 · Impossible-travel arithmetic is wrong
§9 step 3: "Chennai to Delhi in four minutes — 1,760 km/h implied."

Chennai→Delhi great-circle is ≈1,760 **km**. Covered in 4 minutes that is
1,760 × 15 = **26,400 km/h**. The spec has quoted the distance as if it were the
speed. An examiner who does the arithmetic will catch this, and it undercuts the
credibility of the `GEODIST` explanation it is meant to support.

**Resolution:** Keep the 4-minute gap (a 60-minute gap would genuinely imply
1,760 km/h but is unusable on stage). Fix the narration to:
*"1,760 kilometres in four minutes — 26,400 km/h implied. Threshold is 900."*
Detector threshold pinned at **>900 km/h with a ≥200 km minimum distance** (the
distance floor suppresses GPS-jitter false positives on same-city pairs).

### I-4 · Baseline traffic will drown ENTITY_FANOUT in false positives
§5 generates ~500 cards across ~200 devices. That is a mean device→card fan-out of
**2.5**, against a `ENTITY_FANOUT` threshold of **≥3 distinct cards per device**
(§4). Benign traffic will therefore trip the fan-out detector continuously, the
alert feed will be pure noise, and the ring injection — the demo centrepiece — will
land in a feed already full of fan-out alerts and demonstrate nothing.

This is a design flaw, not a typo, and it is the single most likely cause of a
demo that technically works but shows nothing.

**Resolution:** two changes, both in CLAUDE.md §4/§5.

1. **Partition the benign entity assignment.** Each card is assigned a stable home
   device and 1–2 home IPs at generation time, and devices are allocated so that no
   device serves more than **2** cards in benign traffic. Baseline fan-out is
   structurally capped below threshold. Entity counts adjust to ~500 cards /
   ~300 devices / ~400 IPs.
2. **Window the fan-out detector.** Fan-out counts **distinct cards on one entity
   within a rolling 10-minute window**, not for all time — `ZADD` with a timestamp
   score, `ZREMRANGEBYSCORE` trim, `ZCARD` read. Without the window the counter is
   monotonic and every device eventually crosses any threshold given enough runtime.

### I-5 · 150 rows/s cannot be rendered with a 120 ms per-row print animation
§5 specifies ~150 txn/s. §7.5 specifies each arriving tape row prints
character-by-character over ~120 ms. 150 rows/s × 120 ms = 18 seconds of animation
per second of traffic. The tape cannot keep up, the WebSocket will backpressure, and
the browser tab will degrade over a five-minute demo.

**Resolution:** separate ingestion rate from display rate in CLAUDE.md §4.

- The consumer ingests all ~150 txn/s.
- `/topic/txn` publishes a **sampled** stream — reservoir-sampled to ~**8 msg/s** —
  which is roughly one row per 120 ms print cycle and is the fastest a human can
  read anyway.
- **Flagged transactions bypass the sampler and are always published.** The tape
  must never miss an alert.
- The tape DOM is capped at 200 rows with oldest-out eviction.
- The true rate is shown in the KPI strip, which is where the number belongs.

### I-6 · "Both ring queries" are referenced but never defined
§6 and §8 S9 refer to "both ring queries"; §8's compressed lane refers to cutting
"the 'all rings' panel". Neither query is ever written down, in a spec whose §6
declares CLAUDE.md §4 the single source of truth for exactly this.

**Resolution:** both are specified in CLAUDE.md §4.4 —
`RING_FOR_CARD` (seeded variable-length traversal, the centrepiece) and
`ALL_RINGS` (global shared-entity hub scan, powers the cuttable panel).

### I-7 · MongoDB persistence is scheduled after everything that depends on it
§4's consumer writes to MongoDB at step 4 — i.e. from Slice 1b onward. §8 schedules
"Mongo persistence" as Slice 6 (S11, Week 4). The consumer cannot perform step 4 for
three weeks before the slice that builds it. The compressed lane compounds this by
saying "keep the writes, drop the read UI" for a slice in which the writes do not yet
exist.

**Resolution:** the MongoDB write path moves to **Slice 4**, immediately after the
consumer and before the detectors. This is also what the grading constraint requires.
See Part 7.

### Minor gaps closed without ceremony
Specified in CLAUDE.md, flagged here so you know they were decisions, not defaults:
Redis eviction policy (`noeviction` — §10 asks for it but §4 never sets it); AOF
settings (§10 asserts "AOF is on", nothing configures it); the 12 cities and their
coordinates (never listed, yet the travel detector's correctness depends on them);
the three STOMP channel names (§5 says "three live channels", never names them);
detector weights and severity band cutoffs (§5 says "weighted, summed to a severity
band", gives neither); idempotency guard TTL; and container memory limits (§11 asks
for "resource limits tuned for a laptop", §12 assumes a Neo4j heap cap exists).

> **Note on section numbering:** the spec's §7 is *Interface design*, but §5 of the
> spec refers to "CLAUDE.md §7" for side-effect ordering. These are different
> documents with independent numbering. CLAUDE.md §7 is side-effect ordering, per
> your instruction. This is called out in CLAUDE.md §1 to stop it recurring.

---

## Part 1 — `CLAUDE.md` (proposed, in full)

This is deliverable #1, written before any code. Frozen thereafter; changes go
through §8 with a dated entry.

````markdown
# CLAUDE.md — SentinelStream

Frozen source of truth. Re-read at the start of every working session.
The design rationale lives in `docs/NoSQL_Project.md`; **where the two disagree,
this file wins.** Section numbers here are independent of that document's — in
particular, §7 here is side-effect ordering, not interface design.

Changing anything in §2 or §4 requires a dated entry in §8. Do not redesign the
schema mid-project. If a change looks necessary, stop and raise it.

---

## §1 Rules of engagement

1. §4 is frozen. Field names, key names, collection names, labels and index
   definitions do not change without a §8 entry.
2. One vertical slice per session. A slice ends in something runnable and
   demonstrable, or it is not finished.
3. `XACK` is always the last side effect. See §7.
4. Nothing blocking goes on the hot path: no Neo4j write, no synchronous
   per-transaction MongoDB insert, no ring query inline. Buffers and queues only.
5. Rules are deterministic and explainable. No ML. An examiner asking "why was this
   flagged" gets an exact numeric answer.
6. Every MongoDB query that runs in a request path is backed by an index in §4.3.
   If you add a query, add its index in the same commit.

---

## §2 Pinned versions, ports and resource limits

### Runtimes
| Component | Version | Note |
|---|---|---|
| JDK | **21** (Temurin) | Gradle toolchain pins it; local JDK version irrelevant |
| Spring Boot | **3.3.4** | |
| Gradle | **8.8** (wrapper) | |
| Node | **20.14 LTS** | |
| Docker Compose | schema v3.8 | |

### Images
| Service | Image | Why pinned here |
|---|---|---|
| Redis | `redis:7.2-alpine` | Streams + `ZRANGEBYSCORE` + GEO all stable |
| MongoDB | `mongo:7.0` | `$dateTrunc`, `$getField`; run as single-node RS |
| Neo4j | `neo4j:5.20-community` | Cypher 5, `CALL {}` subqueries |
| mongosh | `mongodb/mongodb-community-server:7.0-ubi8` | evidence scripts |

### Key libraries
`spring-boot-starter-data-mongodb`, `-data-redis`, `-data-neo4j`, `-websocket`,
`-validation`, `-actuator`; React 18.3; Vite 5.3; Cytoscape 3.29 + `cytoscape-fcose`
2.2; Recharts 2.12; `@stomp/stompjs` 7.0; TanStack Query 5.

### Ports (host → container)
| Service | Port | |
|---|---|---|
| Redis | 6379 | |
| MongoDB | 27017 | `rs0`, `directConnection=true` |
| Neo4j HTTP (Browser) | 7474 | open during demo, §9 step 6 |
| Neo4j Bolt | 7687 | |
| Spring Boot API | 8080 | `/api/*`, `/ws` |
| React dev (Vite) | 5173 | dev only |
| React prod (nginx) | 3000 | demo runs against this |

### Resource limits (laptop-tuned; §11/§12 of the spec require these)
| Service | Limit | Config |
|---|---|---|
| Neo4j | 1.0 GB | `server.memory.heap.max_size=512m`, `pagecache.size=256m` |
| MongoDB | 1.0 GB | `--wiredTigerCacheSizeGB 0.5` |
| Redis | 768 MB | `maxmemory 512mb`, `maxmemory-policy noeviction` |
| API | 1.0 GB | `-XX:MaxRAMPercentage=75` |

**If Neo4j OOMs, lower the heap — never raise it** (spec §12).

### Redis persistence
`appendonly yes`, `appendfsync everysec`, `save ""` (AOF only, no RDB).
Cold start loses partial in-flight windows; acceptable because windows are ≤60
minutes and self-heal. This is the honest §10 answer, not a defect.

### Redis eviction
`maxmemory-policy noeviction`. **`allkeys-lru` is wrong here** because it would
silently evict `blocklist:cards` and the consumer-group PEL under pressure — losing
a compliance control and breaking at-least-once delivery. Every volatile key carries
an explicit TTL (§4.1); memory is bounded by design, not by eviction. Under genuine
pressure we want writes to fail loudly.

### Connection strings (compose network)
```
REDIS_URL   redis://redis:6379
MONGO_URI   mongodb://mongo:27017/sentinel?replicaSet=rs0&directConnection=true&w=majority
NEO4J_URI   bolt://neo4j:7687   (neo4j / sentinel-dev)
```

---

## §3 Repository layout

```
sentinelstream/
  CLAUDE.md
  README.md
  docker-compose.yml
  docs/
    NoSQL_Project.md          design spec (reference)
    evidence/                 explain() output, generated — §4.3
      explain-report.md
      *.json
    screenshots/
  api/                        Spring Boot
    src/main/java/.../
      generator/  consumer/  detect/  persist/  graph/  triage/  stats/  ws/  control/
      config/MongoIndexConfig.java      index registry, §4.3
      config/MongoValidatorConfig.java  JSON Schema, §4.2
  ui/                         React + Vite
  scripts/
    seed.mjs                  deterministic demo state — Part 8
    explain-evidence.mjs      before/after harness — Part 6
    smoke.sh
```

---

## §4 Data models  — FROZEN

### §4.1 Redis key registry

Ports: `{c}` = cardId, `{d}` = deviceId, `{i}` = ip, `{t}` = txnId.
All times are epoch milliseconds. All TTLs are refreshed on write.

| Key | Type | TTL | Members / value | Written by | Read by |
|---|---|---|---|---|---|
| `txn:stream` | Stream | — | `XADD MAXLEN ~ 100000` (≈11 min @150/s) | generator | consumer group `fraud-detectors` |
| `idem:txn:{t}` | String | **900 s** | `"1"`, set `SET NX EX 900` | consumer step 2 | consumer step 2 |
| `card:{c}:txns` | ZSet | **3600 s** | score `ts`, member `{t}` | step 3 | VELOCITY |
| `card:{c}:amts` | ZSet | **3600 s** | score `ts`, member `"{t}|{amount}"` | step 3 | AMOUNT_ANOMALY |
| `card:{c}:lastgeo` | String | **3600 s** | `"{lat},{lon},{ts}"` | step 3 | IMPOSSIBLE_TRAVEL |
| `card:{c}:geo` | GEO (ZSet) | **3600 s** | member `{t}` | step 3 | `GEODIST`, map panel |
| `device:{d}:cards` | ZSet | **1800 s** | score `ts`, member `{c}` | step 3 | ENTITY_FANOUT |
| `ip:{i}:cards` | ZSet | **1800 s** | score `ts`, member `{c}` | step 3 | ENTITY_FANOUT |
| `blocklist:cards` | Set | **none** | `{c}` | **triage API** (analyst) | consumer step 1 (`SISMEMBER`) |
| `ring:cooldown:{c}` | String | **300 s** | `"1"` | step 8 | step 8 |
| `metrics:txn:{epochMin}` | String | **300 s** | `INCR` counter | step 3 | KPI rate |
| `alerts:live` | Pub/Sub channel | — | alert JSON | step 9 | WS relay |

`blocklist:cards` is the only key without a TTL, deliberately: it is an
analyst-issued control and must survive restarts. It is the reason the eviction
policy is `noeviction`.

**Window trimming.** Every window read is preceded by
`ZREMRANGEBYSCORE <key> -inf <now - windowMs>`. Windows: velocity 60 s, amount
3600 s (last 20 samples via `ZREVRANGE ... 0 19`), fan-out **600 s** (see I-4).

### §4.2 MongoDB collections

Database `sentinel`. Four collections, each with a `$jsonSchema` validator applied
at `validationLevel: "moderate"`, `validationAction: "error"`.

#### `transactions`
```json
{
  "txnId": "T-000000123",            // string, unique
  "cardId": "C-0417",
  "amount": 4821.50,                  // double
  "currency": "INR",
  "ts": ISODate("..."),               // authoritative time
  "merchant": { "id": "M-031", "name": "Pothys", "category": "APPAREL", "mcc": "5651" },
  "city": "Chennai",
  "loc": { "type": "Point", "coordinates": [80.2707, 13.0827] },  // GeoJSON: [lon, lat]
  "deviceId": "D-0142",
  "ip": "49.207.14.88",
  "flagged": false,                   // set by detectors, denormalised for aggregation
  "score": 0,
  "declined": false,                  // true if cardId was on blocklist:cards
  "ingestedAt": ISODate("...")        // TTL anchor
}
```
`flagged` and `score` are denormalised onto the transaction deliberately: the
fraud-rate-by-category pipeline (Part 5, A) would otherwise need a `$lookup` from
`alerts` on every KPI refresh. Justify this as read-optimised denormalisation, the
document-model counterpart to a materialised view.

#### `alerts` — the triage document
```json
{
  "_id": ObjectId("..."),
  "alertId": "A-0000091",             // human-quotable, unique
  "txnId": "T-000000123",             // join key to transactions
  "cardId": "C-0417",
  "ts": ISODate("..."),
  "severity": "HIGH",                 // LOW | MEDIUM | HIGH
  "score": 95,                        // 0..100
  "origin": "DETECTOR",               // DETECTOR | ANALYST  (analyst = manual Create)

  "rules": [                          // heterogeneous — the reason alerts are documents
    { "type": "VELOCITY", "weight": 40,
      "evidence": { "count": 12, "windowSec": 60, "threshold": 5 } },
    { "type": "IMPOSSIBLE_TRAVEL", "weight": 70,
      "evidence": { "fromCity": "Chennai", "toCity": "Delhi", "km": 1760.4,
                    "minutes": 4, "impliedKmh": 26406.0, "threshold": 900 } }
  ],

  "status": "NEW",                    // §4.5 lifecycle
  "assignee": null,
  "notes": [                          // $push target — Update
    { "noteId": "n-1", "author": "analyst.yash", "body": "Checked BIN range.",
      "at": ISODate("..."), "editedAt": null }
  ],
  "statusHistory": [                  // $push target — Update, audit trail
    { "from": null, "to": "NEW", "by": "system", "at": ISODate("...") }
  ],
  "cardBlocked": false,
  "resolution": null,                 // set on CONFIRMED_FRAUD / FALSE_POSITIVE
  "updatedAt": ISODate("...")
}
```
The `rules[].evidence` object has **no fixed shape** — it differs per rule type and
the validator explicitly permits any object there. This is the §3/§9-step-7
justification for documents over a relational alert table, and it must survive
contact with the JSON Schema validator. Do not tighten it.

#### `alerts_archive`
Dismissal target. Same shape as `alerts` plus `dismissedBy`, `dismissedAt`,
`dismissReason`, `originalId`. TTL 7 days.

#### `blocked_cards`
```json
{ "cardId": "C-0417", "blockedBy": "analyst.yash", "blockedAt": ISODate("..."),
  "reason": "Confirmed ring member — shared device D-SEED-01",
  "sourceAlertId": "A-0000091", "active": true, "unblockedAt": null }
```
`cardId` unique. Mirrored into Redis `blocklist:cards`; this document is the
durable record, Redis is the hot-path cache.

#### `ring_snapshots`
```json
{ "ringId": "R-0004", "discoveredAt": ISODate("..."), "seedCardId": "C-0417",
  "cardIds": ["C-0417", ...], "sharedEntities": [{"id":"D-SEED-01","type":"Device","cardCount":6}],
  "edges": [{"from":"C-0417","to":"D-SEED-01","type":"USED_DEVICE"}],
  "hopDepth": 2, "queryMs": 41 }
```
Snapshotted so the demo can re-render a past ring without re-querying Neo4j — the
insurance policy for §9 step 5.

### §4.3 MongoDB index registry — FROZEN

Created idempotently at boot by `MongoIndexConfig`, never by hand, so the examiner
can see them declared in source. `GET /api/admin/indexes` lists them live.

| # | Collection | Index | Type | Serves |
|---|---|---|---|---|
| 1 | transactions | `{ txnId: 1 }` unique | unique | idempotent bulk upsert (§7 step 5) |
| 2 | transactions | `{ cardId: 1, ts: -1 }` | compound | card history; `$lookup` E prior-txn subquery |
| 3 | transactions | `{ ts: -1 }` | single | time-range scans, tape backfill |
| 4 | transactions | `{ "merchant.category": 1, flagged: 1 }` | compound | pipeline A `$group` |
| 5 | transactions | `{ ingestedAt: 1 }` **expireAfterSeconds: 86400** | **TTL** | 24 h raw retention |
| 6 | transactions | `{ loc: "2dsphere" }` | geo | map panel / geo queries |
| 7 | alerts | `{ alertId: 1 }` unique | unique | lookup by quotable id |
| 8 | alerts | `{ severity: 1, ts: -1 }` | compound | alert feed default sort (spec §3) |
| 9 | alerts | `{ cardId: 1, ts: -1 }` | compound | per-card case view (spec §10 viva) |
| 10 | alerts | `{ status: 1, severity: 1, ts: -1 }` | compound | **triage queue** — the ESR index |
| 11 | alerts | `{ txnId: 1 }` | single | `$lookup` E join key |
| 12 | alerts | `{ "rules.type": 1, ts: -1 }` | multikey | rule-activity chart, `byRule` facet |
| 13 | alerts_archive | `{ dismissedAt: 1 }` **expireAfterSeconds: 604800** | TTL | 7 d archive |
| 14 | blocked_cards | `{ cardId: 1 }` unique | unique | block/unblock upsert |
| 15 | ring_snapshots | `{ discoveredAt: -1 }` | single | ring history |

**Index #10 is the one to be able to defend.** It follows **ESR** — Equality
(`status`), Sort (`ts`), Range — with `severity` placed second because the triage
queue is always filtered by an exact status and usually by an exact severity, then
sorted by time. Asked why not `{ts: -1, status: 1}`: because a leading sort field
forces the equality predicates to be evaluated as a filter over the whole time range
rather than as an index seek.

**TTL caveat to state aloud, not hide:** index #5 expires raw transactions after 24
hours while alerts are kept indefinitely, so pipeline E (`$lookup` alert→transaction)
returns an empty join for alerts older than a day. This is a deliberate hot-store /
cold-store split — the alert carries its own evidence snapshot in `rules[].evidence`
and does not depend on the transaction surviving. The seed script writes transactions
with recent `ingestedAt` so a seeded demo stays intact for 24 hours; re-run
`seed.mjs` if the demo is more than a day old.

### §4.4 Neo4j schema

**Node labels and keys**

| Label | Key property | Other properties |
|---|---|---|
| `Card` | `cardId` | `firstSeen`, `lastSeen`, `txnCount`, `blocked` |
| `Device` | `deviceId` | `firstSeen`, `lastSeen` |
| `Ip` | `ip` | `firstSeen`, `lastSeen` |
| `Merchant` | `merchantId` | `name`, `category` |

**Relationship types** (always `Card` → entity, so direction is uniform)

| Type | Pattern | Properties |
|---|---|---|
| `USED_DEVICE` | `(:Card)-[:USED_DEVICE]->(:Device)` | `count`, `firstSeen`, `lastSeen` |
| `FROM_IP` | `(:Card)-[:FROM_IP]->(:Ip)` | `count`, `firstSeen`, `lastSeen` |
| `PAID` | `(:Card)-[:PAID]->(:Merchant)` | `count`, `lastSeen`, `totalAmount` |

**Transactions are not nodes.** A transaction is an event, not an entity; modelling
150/s as nodes would add ~13 M nodes/day carrying no traversal value. Edges carry
`count` instead. This is the §10 viva answer.

**Constraints** (each also creates the backing index that makes the traversal seed
lookup O(1)):
```cypher
CREATE CONSTRAINT card_id   IF NOT EXISTS FOR (c:Card)     REQUIRE c.cardId     IS UNIQUE;
CREATE CONSTRAINT device_id IF NOT EXISTS FOR (d:Device)   REQUIRE d.deviceId   IS UNIQUE;
CREATE CONSTRAINT ip_addr   IF NOT EXISTS FOR (i:Ip)       REQUIRE i.ip         IS UNIQUE;
CREATE CONSTRAINT merch_id  IF NOT EXISTS FOR (m:Merchant) REQUIRE m.merchantId IS UNIQUE;
```

**Projector write (batched, `MERGE` never `CREATE`)** — `UNWIND` a batch so one
round trip covers up to 100 edges:
```cypher
UNWIND $batch AS row
MERGE (c:Card {cardId: row.cardId})
  ON CREATE SET c.firstSeen = row.ts, c.txnCount = 0
SET c.lastSeen = row.ts, c.txnCount = c.txnCount + 1
MERGE (d:Device {deviceId: row.deviceId})
  ON CREATE SET d.firstSeen = row.ts
SET d.lastSeen = row.ts
MERGE (c)-[ud:USED_DEVICE]->(d)
  ON CREATE SET ud.count = 0, ud.firstSeen = row.ts
SET ud.count = ud.count + 1, ud.lastSeen = row.ts
MERGE (i:Ip {ip: row.ip})
  ON CREATE SET i.firstSeen = row.ts
SET i.lastSeen = row.ts
MERGE (c)-[fi:FROM_IP]->(i)
  ON CREATE SET fi.count = 0, fi.firstSeen = row.ts
SET fi.count = fi.count + 1, fi.lastSeen = row.ts;
```

#### RING QUERY 1 — `RING_FOR_CARD` (the centrepiece)
Called from §7 step 8 when `ENTITY_FANOUT` fires. Returns the whole subgraph in one
traversal, shaped for Cytoscape.
```cypher
MATCH (seed:Card {cardId: $cardId})
CALL {
  WITH seed
  MATCH (seed)-[:USED_DEVICE|FROM_IP*1..6]-(m:Card)
  RETURN collect(DISTINCT m) AS others
}
WITH [seed] + others AS cards
UNWIND cards AS c
MATCH (c)-[r:USED_DEVICE|FROM_IP]->(e)
WITH cards, c, r, e
WHERE size([ (x:Card)-[:USED_DEVICE|FROM_IP]->(e) WHERE x IN cards | x ]) >= 2
RETURN
  [x IN cards | { id: x.cardId, blocked: coalesce(x.blocked, false) }]      AS cardNodes,
  collect(DISTINCT { id: coalesce(e.deviceId, e.ip),
                     type: head(labels(e)) })                               AS entityNodes,
  collect(DISTINCT { from: c.cardId,
                     to:   coalesce(e.deviceId, e.ip),
                     rel:  type(r), weight: r.count })                      AS edges;
```
`*1..6` is **bounded** because an unbounded variable-length match over a densely
connected payment graph degenerates toward a full traversal, and because a genuine
ring is card→device→card→ip→card — three hops of separation is already weak
evidence, six is the outer limit of usefulness. The bound is a correctness and cost
decision, not a safety net.

The `size([...]) >= 2` filter drops entities touched by only one ring member, so the
rendered graph shows *shared* infrastructure rather than every device each card ever
used. Without it the ring panel is a hairball.

#### RING QUERY 2 — `ALL_RINGS` (global sweep, powers the cuttable panel)
```cypher
MATCH (e)<-[:USED_DEVICE|FROM_IP]-(c:Card)
WHERE e:Device OR e:Ip
WITH e, collect(DISTINCT c) AS cards
WHERE size(cards) >= $minFanout            // default 3
RETURN coalesce(e.deviceId, e.ip) AS entityId,
       head(labels(e))            AS entityType,
       size(cards)                AS cardCount,
       [x IN cards | x.cardId]    AS cardIds
ORDER BY cardCount DESC
LIMIT $limit;
```

### §4.5 Alert status lifecycle

```
          ┌──────────────── reopen ───────────────┐
          ▼                                       │
  NEW ──▶ INVESTIGATING ──┬──▶ CONFIRMED_FRAUD ───┘
   │                      │           │
   │                      │           └──▶ (block card)
   │                      └──▶ FALSE_POSITIVE
   │                                  │
   └──────────────────────────────────┴──▶ [DELETE → alerts_archive]
```
Legal transitions are enforced server-side in `TriageService`; an illegal transition
is `409 Conflict`, not a silent no-op. Every transition `$push`es a `statusHistory`
entry. Deletion is permitted only from `FALSE_POSITIVE` or `NEW`; a
`CONFIRMED_FRAUD` alert cannot be dismissed.

### §4.6 Reference data — 12 cities

Pinned because the travel detector's correctness depends on exact coordinates.

| City | Lat | Lon | | City | Lat | Lon |
|---|---|---|---|---|---|---|
| Delhi | 28.6139 | 77.2090 | | Ahmedabad | 23.0225 | 72.5714 |
| Mumbai | 19.0760 | 72.8777 | | Jaipur | 26.9124 | 75.7873 |
| Chennai | 13.0827 | 80.2707 | | Lucknow | 26.8467 | 80.9462 |
| Bengaluru | 12.9716 | 77.5946 | | Kochi | 9.9312 | 76.2673 |
| Kolkata | 22.5726 | 88.3639 | | Guwahati | 26.1445 | 91.7362 |
| Hyderabad | 17.3850 | 78.4867 | | Pune | 18.5204 | 73.8567 |

Chennai→Delhi ≈ **1,760 km**. That is a distance, not a speed (see §8, D-03).

---

## §5 Rules engine constants

Externalised to `application.yml` under `sentinel.rules.*`; values here are the
defaults and the ones quoted in the report.

| Rule | Fires when | Weight |
|---|---|---|
| `VELOCITY` | ≥ **5** txns for one card in **60 s** | **40** |
| `AMOUNT_ANOMALY` | amount > mean + **3σ** over last **20** txns (min 5 samples) | **25** |
| `IMPOSSIBLE_TRAVEL` | implied speed > **900 km/h** over ≥ **200 km** | **70** |
| `ENTITY_FANOUT` | one device **or** IP with ≥ **3** distinct cards in **600 s** | **55** |

`score = min(100, Σ weights)`. Bands: **LOW 1–39 · MEDIUM 40–69 · HIGH 70–100.**

Calibrated so the §7.4 mock is truthful: `IMPOSSIBLE_TRAVEL` alone → HIGH,
`VELOCITY` alone → MEDIUM, `ENTITY_FANOUT` alone → MEDIUM, fan-out + velocity → 95
HIGH. No rule alone lands in LOW, so LOW means "one weak rule plus noise" — which is
what it should mean.

### Injectable patterns (spec §5, corrected per §8 D-02/D-03)
| Endpoint | Behaviour |
|---|---|
| `POST /api/control/inject/velocity` | one card, **12 txns in 20 s** (threshold is 5/60 s) |
| `POST /api/control/inject/travel` | Chennai → Delhi, **4 min** apart → 26,400 km/h |
| `POST /api/control/inject/ring` | **6** cards onto shared device `D-SEED-01` + 2 IPs, staggered 2 s |
| `POST /api/control/generator/pause` | pause benign traffic (added — deterministic demo) |
| `POST /api/control/generator/resume` | resume |

Fan-out fires at the **3rd** card, ~6 s in — before all six have transacted. The
ring query then returns all six as they arrive. Narrate it that way: Redis notices
early and partially; Neo4j resolves the whole group.

---

## §6 API surface

`/api/txns` · `/api/alerts` · `/api/cards` · `/api/rings` · `/api/stats` ·
`/api/control` · `/api/admin`. Full triage and stats routes in the plan, Parts 4–5.

**STOMP** — endpoint `/ws` (SockJS fallback), the three live channels of spec §5:

| Topic | Payload | Rate |
|---|---|---|
| `/topic/txn` | transaction summary | **sampled to ~8/s**; flagged always pass (§8 D-05) |
| `/topic/alerts` | full alert document | unsampled |
| `/topic/rings` | ring snapshot | on discovery |

The KPI strip is **not** a fourth topic — it polls `GET /api/stats/kpi` (the `$facet`
pipeline) every 3 s. One round trip, one pipeline, and it keeps the channel count at
three as specified.

---

## §7 Consumer side-effect ordering — FROZEN

Fixed order. `XACK` is always last. Deviating from this order is a correctness bug,
not a style choice.

```
XREADGROUP (group: fraud-detectors, consumer: ${HOSTNAME})
 │
 1. BLOCKLIST CHECK      SISMEMBER blocklist:cards {cardId}
 │                       → if member: mark txn.declined = true; skip detectors 4;
 │                         still persist (5) and still XACK (10).
 │
 2. IDEMPOTENCY GUARD    SET idem:txn:{txnId} 1 NX EX 900
 │                       → if NOT acquired: this is a redelivery already processed.
 │                         XACK and return. No side effects repeated.
 │
 3. WINDOW UPDATES       pipelined, single round trip:
 │                       ZREMRANGEBYSCORE (trim) ×4
 │                       ZADD card:{c}:txns / :amts · GEOADD card:{c}:geo
 │                       SET card:{c}:lastgeo · ZADD device:{d}:cards / ip:{i}:cards
 │                       INCR metrics:txn:{epochMin} · EXPIRE all
 │
 4. EVALUATE DETECTORS   4 rules, pure functions over the window reads → score, band
 │
 5. PERSIST TRANSACTION  → MongoBulkWriter buffer (non-blocking, Part 7)
 │                         NOT insertOne. Flush on 200 docs or 500 ms.
 │
 6. PERSIST ALERT        if score > 0: SYNCHRONOUS insertOne into alerts
 │                       Deliberate asymmetry — alerts are ~1/s not 150/s, they are
 │                       the durable record, and step 9 must not publish an alert the
 │                       API cannot yet serve. Buffering them would race the UI.
 │
 7. ENQUEUE GRAPH EDGES  → Neo4jProjector queue (bounded, 500 ms / 100 edges)
 │                         Never a synchronous Bolt call on the hot path.
 │
 8. RING QUERY           if ENTITY_FANOUT fired AND ring:cooldown:{c} absent:
 │                       SET ring:cooldown:{c} 1 NX EX 300
 │                       → async executor: RING_FOR_CARD → ring_snapshots
 │                         → PUBLISH /topic/rings.   Never inline.
 │
 9. PUBLISH              PUBLISH alerts:live (alerts, always)
 │                       /topic/txn (sampled, §6)
 │
10. XACK  ── always last, always
```

**Why `XACK` last.** A crash between any step and step 10 leaves the entry in the
consumer group's PEL, and it is redelivered. Redelivery is safe because step 2's
guard short-circuits an already-processed id, and because `txnId` is uniquely
indexed (index #1) so the bulk upsert is idempotent at the storage layer too. The
system is at-least-once in delivery and effectively-once in effect. `XPENDING` /
`XAUTOCLAIM` reclaim entries orphaned by a consumer that dies permanently; a
scheduled reclaimer runs every 30 s for entries idle > 60 s.

**Ordering rationale in one line each:** blocklist first because a blocked card
should not update behavioural windows; idempotency before any mutation; windows
before detectors because detectors read them; transaction before alert because an
alert referencing a missing transaction is a broken `$lookup`; graph after Mongo
because the graph is derived and eventually consistent; ring query last because it
is the only step that can take tens of milliseconds.

---

## §8 Decision log

| # | Date | Decision | Rationale |
|---|---|---|---|
| D-01 | 2026-09-14 | Throughput is **150 txn/s**; the §7.4 mock's `1,284 txn/s` is placeholder | Two figures in the spec; the abstract and architecture both say 150. KPI strip shows the live measured rate. |
| D-02 | 2026-09-14 | Velocity **injector = 12 txns / 20 s**; velocity **threshold = 5 / 60 s** | §5 and §9 disagreed because they described different things. Both kept, stated separately. |
| D-03 | 2026-09-14 | Impossible-travel narration corrected to **26,400 km/h**; threshold **900 km/h** | §9 quoted the Chennai–Delhi *distance* (1,760 km) as a *speed*. 1,760 km in 4 min is 26,400 km/h. |
| D-04 | 2026-09-14 | Benign entity assignment **partitioned** (≤2 cards/device) and fan-out **windowed to 600 s** | 500 cards / 200 devices gave mean fan-out 2.5 against a threshold of 3 — baseline traffic would have alerted continuously and buried the ring demo. |
| D-05 | 2026-09-14 | `/topic/txn` **sampled to ~8 msg/s**; flagged txns always published | 150 rows/s against §7.5's 120 ms print-in is 18 s of animation per second. Ingestion rate and display rate are now separate concerns. |
| D-06 | 2026-09-14 | Two ring queries defined: `RING_FOR_CARD`, `ALL_RINGS` | Spec referred to "both ring queries" without ever writing either. |
| D-07 | 2026-09-14 | MongoDB persistence moved from Slice 6 (Week 4) to **Slice 4** | §4's consumer writes to Mongo at step 4 from the first slice; §8 scheduled that code three weeks later. Also required by the grading rubric. |
| D-08 | 2026-09-14 | **Alert triage workflow** added as a first-class feature | Spec had no Update and no Delete. Triage supplies both from the UI, and the block-card write-back closes a Mongo→Redis loop that strengthens the design argument. |
| D-09 | 2026-09-14 | Dismissal is **archive-then-hard-delete** | Rubric needs a real `deleteOne`/`deleteMany` with a visible count drop; the archive copy keeps the audit answer defensible. |
| D-10 | 2026-09-14 | MongoDB runs as a **single-node replica set** (`rs0`) | Enables a real multi-document transaction for the block-card write-back, and makes the change-streams viva answer "available, and here is why I still did not use it". |
| D-11 | 2026-09-14 | Transactions **denormalise** `flagged` and `score` | Avoids a `$lookup` on every KPI refresh. Read-optimised denormalisation is the document-model idiom; state it rather than apologise for it. |
| D-12 | 2026-09-14 | Redis `maxmemory-policy noeviction`, every volatile key TTL'd | `allkeys-lru` could evict `blocklist:cards` (a compliance control) and the PEL (breaking at-least-once). Answers the §10 viva question directly. |
| D-13 | 2026-09-14 | Alerts written **synchronously**, transactions **buffered** | 150:1 volume ratio; alerts are the durable record and must be readable the instant they are published to the UI. |
| D-14 | 2026-09-14 | Raw transactions **TTL 24 h**; alerts kept indefinitely | Hot/cold split. Alerts self-contain their evidence, so an expired transaction does not orphan an alert. |
| D-15 | 2026-09-14 | Added `POST /api/control/generator/pause` | The seed script needs a quiescent stream to produce a deterministic demo state. |
````

---

## Part 2 — Alert triage workflow (supplies Update and Delete)

The examiner needs to see all four operations **from the UI**. Triage is the
container for three of them.

### The four operations, and where each is demonstrated

| Op | Mongo operation | UI affordance |
|---|---|---|
| **Create** | `insertOne` into `alerts` with `origin: "ANALYST"` | **"Raise case"** button — analyst opens a case on a card with no detector alert |
| **Read** | `find` + `aggregate` with `$lookup` | Triage queue table; alert detail drawer |
| **Update** | `findOneAndUpdate` with `$set`, `$push`, `$pull`, positional `$[elem]` | Status dropdown; note composer; note edit/delete; block-card toggle |
| **Delete** | `deleteOne`, `deleteMany` | Dismiss button (single); "Purge dismissed" (bulk) |

Create is deliberately analyst-driven rather than pointing at the consumer's inserts
— the examiner must see the operation *caused from the UI*, and "the background
process does inserts" is a weaker demonstration.

### REST endpoints

```
# ---- Read
GET    /api/alerts?status=&severity=&cardId=&rule=&from=&to=&page=&size=&sort=
         → paged; hits index #10 {status,severity,ts}
GET    /api/alerts/{alertId}
         → aggregation E: $lookup to transactions + prior-10-txn context

# ---- Create
POST   /api/alerts/manual
         { cardId, severity, reason, author }
         → insertOne, origin:"ANALYST", rules:[{type:"MANUAL_REVIEW",weight:0,
           evidence:{reason}}], status:"NEW", statusHistory seeded

# ---- Update
PATCH  /api/alerts/{alertId}/status
         { to, by, resolution? }
         → findOneAndUpdate: $set {status,updatedAt,assignee,resolution}
                             $push {statusHistory: {from,to,by,at}}
         → 409 if transition illegal per §4.5
POST   /api/alerts/{alertId}/notes
         { author, body }
         → $push {notes: {$each:[note], $slice:-50, $sort:{at:1}}}
           ($slice caps unbounded array growth — the classic document-model trap;
            worth one sentence in the report)
PATCH  /api/alerts/{alertId}/notes/{noteId}
         → $set {"notes.$[n].body":…, "notes.$[n].editedAt":…}
           arrayFilters: [{"n.noteId": noteId}]        ← positional filtered update
DELETE /api/alerts/{alertId}/notes/{noteId}
         → $pull {notes: {noteId}}
PATCH  /api/alerts/{alertId}/assign        { assignee }   → $set

# ---- Update spanning stores: the block-card write-back
POST   /api/cards/{cardId}/block
         { reason, by, sourceAlertId }
         → Mongo transaction (rs0, D-10):
             1. blocked_cards.updateOne({cardId},{$set:{…active:true}},{upsert:true})
             2. alerts.updateMany({cardId, status:{$ne:"FALSE_POSITIVE"}},
                                  {$set:{cardBlocked:true}, $push:{statusHistory:…}})
           commit
         → then Redis SADD blocklist:cards {cardId}      (after commit, idempotent)
         → then STOMP /topic/alerts refresh nudge
DELETE /api/cards/{cardId}/block
         → $set {active:false, unblockedAt} + SREM blocklist:cards

# ---- Delete
DELETE /api/alerts/{alertId}?reason=…&by=…
         → 1. read doc  2. insertOne into alerts_archive (+dismissedBy/At/Reason)
           3. alerts.deleteOne({_id})         ← the real delete
         → 403 if status == CONFIRMED_FRAUD
DELETE /api/alerts?status=FALSE_POSITIVE&before=<iso>&by=…
         → bulk: archive matching docs, then alerts.deleteMany(filter)
         → returns { archived, deletedCount }   ← the number to point at on stage
```

### UI affordances

**Triage queue** (new primary panel, tab-switched with the alert feed):
a dense table — severity chip, rule badges, masked card, age, status pill, assignee.
Filters across the top map to index #10's field order. Row count and
`deletedCount` are visible so a delete is *seen*, not asserted.

**Alert detail drawer** (slides from the right, does not navigate away):
- Header: alertId, severity, score, status pill.
- **Status control** — a segmented control showing only legal next states per §4.5.
  Illegal transitions are absent, not disabled-with-a-tooltip.
- **Evidence block** — `rules[]` rendered as one card per rule with its raw
  `evidence` object pretty-printed. This is the §9 step 7 moment, now inside the UI.
- **Transaction context** — the `$lookup` result: the triggering transaction plus the
  prior 10 on that card, as a mini-tape. Labelled *"joined via $lookup"* so the
  examiner knows what they are looking at.
- **Notes** — composer at the bottom, list above; each note has edit and delete.
- **Audit trail** — `statusHistory` as a vertical timeline.
- **Footer** — `Block card` (destructive-styled, confirm dialog naming the card) and
  `Dismiss` (opens reason prompt, then deletes).

**Live feedback loop, the moment worth rehearsing:** after blocking a card, the
settlement tape shows that card's next transactions rendered struck-through with a
`DECLINED` marker — because §7 step 1 read the Redis set the API just wrote. A
MongoDB update visibly altering the live stream, through Redis, in front of the
examiner. That is one sentence of narration and it demonstrates Update, cross-store
consistency and the hot-path design at once.

**Blocklist panel** — small table of `blocked_cards` with an unblock action, so the
Update can be reversed live and repeated if the first attempt is missed.

---

## Part 3 — MongoDB aggregation pipelines

Five pipelines, each written out below with its consuming panel. All are exposed
under `/api/stats/*` and additionally dumped to `docs/evidence/pipelines.md` for the
report appendix.

### A · Fraud rate by merchant category → **"Category Risk" bar chart**
`GET /api/stats/fraud-by-category?hours=24`
```js
[
  { $match: { ts: { $gte: since } } },
  { $group: {
      _id: "$merchant.category",
      total:   { $sum: 1 },
      flagged: { $sum: { $cond: ["$flagged", 1, 0] } },
      volume:  { $sum: "$amount" },
      flaggedVolume: { $sum: { $cond: ["$flagged", "$amount", 0] } }
  }},
  { $match: { total: { $gte: 20 } } },          // suppress small-sample noise
  { $addFields: {
      fraudRate: { $round: [ { $divide: ["$flagged", "$total"] }, 4 ] },
      avgTicket: { $round: [ { $divide: ["$volume", "$total"] }, 2 ] }
  }},
  { $sort: { fraudRate: -1 } },
  { $limit: 12 },
  { $project: { _id: 0, category: "$_id", total: 1, flagged: 1,
                fraudRate: 1, avgTicket: 1,
                flaggedVolume: { $round: ["$flaggedVolume", 2] } } }
]
```
Served by index #4 `{merchant.category: 1, flagged: 1}`. The `$match` after `$group`
is intentional and is the honest answer to "why is this filter not pushed up" — it
filters on a computed group size, which cannot be evaluated before grouping.

### B · Severity distribution bucketed over time → **"Rule Activity" stacked area (60 min)**
`GET /api/stats/severity-timeline?minutes=60&binSize=1`
```js
[
  { $match: { ts: { $gte: since } } },
  { $group: {
      _id: { bucket: { $dateTrunc: { date: "$ts", unit: "minute", binSize: 1 } },
             severity: "$severity" },
      n: { $sum: 1 },
      avgScore: { $avg: "$score" }
  }},
  { $group: {
      _id: "$_id.bucket",
      counts: { $push: { k: "$_id.severity", v: "$n" } },
      total:  { $sum: "$n" },
      avgScore: { $avg: "$avgScore" }
  }},
  { $sort: { _id: 1 } },
  { $project: {
      _id: 0,
      bucket: "$_id",
      total: 1,
      avgScore: { $round: ["$avgScore", 1] },
      bySeverity: { $mergeObjects: [ { LOW: 0, MEDIUM: 0, HIGH: 0 },
                                     { $arrayToObject: "$counts" } ] }
  }}
]
```
The `$mergeObjects` over a zero-filled template matters: without it, a minute with no
HIGH alerts omits the key entirely and Recharts draws a gap in the stack rather than
a zero. A small thing that makes the chart correct.

### C · Top-N cards by alert count → **"Watchlist" leaderboard panel**
`GET /api/stats/top-cards?limit=10&hours=24`
```js
[
  { $match: { ts: { $gte: since } } },
  { $group: {
      _id: "$cardId",
      alerts:   { $sum: 1 },
      high:     { $sum: { $cond: [ { $eq: ["$severity", "HIGH"] }, 1, 0 ] } },
      maxScore: { $max: "$score" },
      lastTs:   { $max: "$ts" },
      ruleSets: { $addToSet: "$rules.type" },      // array of arrays (rules is an array)
      blocked:  { $max: { $cond: ["$cardBlocked", 1, 0] } }
  }},
  { $addFields: {
      rules: { $reduce: { input: "$ruleSets", initialValue: [],
                          in: { $setUnion: ["$$value", "$$this"] } } },
      blocked: { $eq: ["$blocked", 1] }
  }},
  { $sort: { high: -1, alerts: -1, maxScore: -1 } },
  { $limit: 10 },
  { $project: {
      _id: 0, cardId: "$_id", alerts: 1, high: 1, maxScore: 1, lastTs: 1,
      rules: 1, blocked: 1,
      masked: { $concat: [ "····", { $substrBytes: [ "$_id",
                   { $subtract: [ { $strLenBytes: "$_id" }, 4 ] }, 4 ] } ] }
  }}
]
```
`$rules.type` on an array field yields an array-of-arrays; the `$reduce`/`$setUnion`
flattens it to a distinct rule set. Worth knowing why that step is there — it is a
likely viva question about multikey paths.

### D · `$facet` powering the entire KPI strip in one round trip
`GET /api/stats/kpi?minutes=60` — polled every 3 s by the KPI strip.
```js
[
  { $match: { ts: { $gte: since } } },
  { $facet: {
      totals:     [ { $count: "alerts" } ],
      bySeverity: [ { $group: { _id: "$severity", n: { $sum: 1 } } } ],
      byRule:     [ { $unwind: "$rules" },
                    { $group: { _id: "$rules.type", n: { $sum: 1 },
                                avgWeight: { $avg: "$rules.weight" } } },
                    { $sort: { n: -1 } } ],
      scoreBands: [ { $bucket: { groupBy: "$score",
                                 boundaries: [0, 40, 70, 90, 101],
                                 default: "unscored",
                                 output: { n: { $sum: 1 },
                                           avgScore: { $avg: "$score" } } } } ],
      queue:      [ { $group: { _id: "$status", n: { $sum: 1 } } } ],
      blocked:    [ { $match: { cardBlocked: true } },
                    { $group: { _id: "$cardId" } }, { $count: "cards" } ],
      latest:     [ { $sort: { ts: -1 } }, { $limit: 5 },
                    { $project: { _id: 0, alertId: 1, cardId: 1,
                                  severity: 1, ts: 1 } } ]
  }},
  { $project: {
      alerts:      { $ifNull: [ { $first: "$totals.alerts" }, 0 ] },
      blockedCards:{ $ifNull: [ { $first: "$blocked.cards" }, 0 ] },
      bySeverity:  { $mergeObjects: [ { LOW:0, MEDIUM:0, HIGH:0 },
                       { $arrayToObject: { $map: { input: "$bySeverity", as: "s",
                           in: { k: "$$s._id", v: "$$s.n" } } } } ] },
      queue:       { $arrayToObject: { $map: { input: "$queue", as: "q",
                       in: { k: "$$q._id", v: "$$q.n" } } } },
      byRule: 1, scoreBands: 1, latest: 1
  }}
]
```
This is the pipeline to lead with. It is one round trip replacing seven, it nests
`$bucket` and `$unwind` inside `$facet` sub-pipelines, and the panel it feeds is the
first thing on screen. Say out loud that each sub-pipeline sees the same `$match`
output, so the KPI tiles are mutually consistent — seven separate queries against a
live stream would not be.

### E · `$lookup` joining alerts to their transactions → **Alert detail drawer**
`GET /api/alerts/{alertId}`
```js
[
  { $match: { alertId: alertId } },
  // 1 — the triggering transaction
  { $lookup: { from: "transactions", localField: "txnId",
               foreignField: "txnId", as: "txn" } },
  { $unwind: { path: "$txn", preserveNullAndEmptyArrays: true } },   // TTL-safe
  // 2 — the prior 10 transactions on the same card: correlated sub-pipeline
  { $lookup: {
      from: "transactions",
      let: { card: "$cardId", at: "$ts" },
      pipeline: [
        { $match: { $expr: { $and: [ { $eq: ["$cardId", "$$card"] },
                                     { $lt: ["$ts", "$$at"] } ] } } },
        { $sort:  { ts: -1 } },
        { $limit: 10 },
        { $project: { _id: 0, txnId: 1, ts: 1, amount: 1, city: 1,
                      declined: 1, merchant: "$merchant.name" } }
      ],
      as: "priorTxns" } },
  // 3 — block status
  { $lookup: { from: "blocked_cards", localField: "cardId",
               foreignField: "cardId", as: "block" } },
  { $project: {
      _id: 0, alertId: 1, cardId: 1, severity: 1, score: 1, status: 1,
      assignee: 1, ts: 1, rules: 1, notes: 1, statusHistory: 1,
      txn: 1, priorTxns: 1,
      blocked: { $ifNull: [ { $first: "$block.active" }, false ] },
      priorCount: { $size: "$priorTxns" }
  }}
]
```
The correlated `let`/`pipeline` lookup is the one to defend: it is served by index #2
`{cardId: 1, ts: -1}` — exactly the compound index the §10 viva asks about, with the
field order justified by this query. `preserveNullAndEmptyArrays` is what keeps the
drawer working for alerts whose transaction has TTL'd out (§4.3 caveat).

---

## Part 4 — Index strategy and `explain()` evidence

### Strategy across the three stores

**MongoDB** — 15 indexes, registry in CLAUDE.md §4.3, created idempotently at boot
from `MongoIndexConfig` so they are visible in source review, not just in a shell
transcript. Includes 2 unique, 2 TTL, 1 `2dsphere`, 1 multikey, and the ESR-ordered
triage index #10. `GET /api/admin/indexes` renders the live list in the UI's admin
drawer.

**Redis** — indexing is the data structure choice; there is no separate index. The
argument to make: `card:{c}:txns` as a **ZSet** gives an O(log N) skiplist-ordered
window with O(1) `ZCARD`, where a List would require an O(N) scan to count entries
inside a time bound and could not be trimmed by score at all. `GEOADD` maintains a
geohash-scored sorted set, making `GEODIST` O(1). Record the reasoning in the report
next to the Mongo `explain()` table as the "index equivalent" for Redis.

**Neo4j** — the four uniqueness constraints each create a backing range index, which
is what makes the ring query's seed lookup (`MATCH (seed:Card {cardId: $x})`) an
index seek rather than a label scan. Evidence captured with `PROFILE`: run
`RING_FOR_CARD` before and after creating `card_id`, and record `db hits` and the
`NodeByLabelScan` → `NodeUniqueIndexSeek` operator change. This is the Neo4j
counterpart to `COLLSCAN` → `IXSCAN` and belongs in the same README table.

### Capturing the evidence

`scripts/explain-evidence.mjs`, run against a freshly seeded database (Part 8) so
the numbers are reproducible and quotable:

```
for each of 6 probe queries:
   1. ensure seeded state, note collection count
   2. dropIndex(target)            ← if it exists
   3. explain("executionStats")    → BEFORE
   4. createIndex(target)
   5. explain("executionStats")    → AFTER
   6. write docs/evidence/<probe>.before.json / .after.json
   7. extract: winningPlan stage, totalDocsExamined, totalKeysExamined,
      nReturned, executionTimeMillis, indexName
finally: recreate the full §4.3 registry (the script must leave the DB whole)
```

**Probe queries** — one per index worth defending:

| Probe | Query | Index | Expected shift |
|---|---|---|---|
| P1 | triage queue: `{status:"NEW", severity:"HIGH"}` sort `{ts:-1}` | #10 | COLLSCAN + in-memory SORT → IXSCAN, no SORT stage |
| P2 | card history: `{cardId:"C-0417"}` sort `{ts:-1}` limit 10 | #2 | COLLSCAN → IXSCAN, docsExamined → 10 |
| P3 | pipeline A `$group` by category | #4 | COLLSCAN → IXSCAN covered scan |
| P4 | pipeline E correlated `$lookup` | #2 | nested-loop COLLSCAN per outer doc → IXSCAN |
| P5 | alert feed: `{severity:"HIGH"}` sort `{ts:-1}` | #8 | COLLSCAN → IXSCAN |
| P6 | Neo4j `RING_FOR_CARD` (PROFILE) | `card_id` | NodeByLabelScan → NodeUniqueIndexSeek |

The script emits `docs/evidence/explain-report.md` — a table the README embeds
verbatim:

| Probe | Stage before | Docs examined before | ms before | Stage after | Docs examined after | ms after | Improvement |
|---|---|---|---|---|---|---|---|
| P1 | COLLSCAN+SORT | 50,000 | … | IXSCAN | 42 | … | … |

Seed volume is set at **50,000 transactions / 2,000 alerts** specifically so the
before/after gap is large enough to be visually obvious on a projector. At 500 docs
the difference is noise and the evidence is unconvincing.

**Also capture:** one `explain()` showing a query the indexes do *not* help —
a regex `$contains` over note bodies — and name it in the README as known and
accepted. Showing you know where your indexes stop is worth more than a table of
uniformly green rows.

---

## Part 5 — Buffered bulk-write path for MongoDB

At 150 txn/s, `insertOne` per transaction means 150 round trips/s each with its own
write-concern acknowledgement, on the hot path, ahead of `XACK`. The consumer's
per-message budget collapses and the stream backs up. The spec already solved this
shape for Neo4j (§5: "bounded queue, flushed every 500ms or 100 edges"); mirror it.

**`MongoBulkWriter`**, deliberately parallel to `Neo4jProjector`:

| | Neo4jProjector (spec §5) | MongoBulkWriter (new) |
|---|---|---|
| Queue | bounded | `ArrayBlockingQueue<Document>`, capacity **5,000** (~33 s of traffic) |
| Flush trigger | 500 ms or 100 edges | **500 ms or 200 docs**, whichever first |
| Write | `UNWIND` + `MERGE` | `bulkWrite(ordered: false)` of `ReplaceOneModel` upserts on `txnId` |
| Thread | dedicated | single dedicated flusher (`ScheduledExecutorService`) |
| Hot path cost | enqueue only | enqueue only — `offer()`, never `put()` |

**Details that matter:**

- **Unordered** `bulkWrite` so one bad document does not abort the batch, and so the
  server may parallelise. Collect `BulkWriteError`s, log, continue.
- **Upsert on `txnId`, not insert**, so redelivery after a crash between §7 step 5
  and step 10 is idempotent at the storage layer as well as at the guard. Index #1
  (unique on `txnId`) enforces it.
- **Write concern `w:1`** for transactions (replayable from the stream if lost),
  **`w:"majority"`** for alerts (the durable record). State this asymmetry; it is a
  CAP question answered concretely.
- **Backpressure policy, explicit:** `offer()` returns false when full → increment a
  `bulk.dropped` counter, log at WARN with the queue depth, and **do not block the
  consumer**. Dropping a transaction under sustained overload is correct here: it is
  still in the Redis stream (`MAXLEN ~100000`, ~11 min) and recoverable, whereas
  blocking the consumer stalls detection, which is the thing with the latency budget.
  Have this answer ready — "what do you drop under load, and why that" is exactly
  the §10-style question.
- **Graceful shutdown:** `@PreDestroy` drains the queue with a 5 s timeout so a
  `docker compose down` does not lose the tail of the demo.
- **Metrics** on Actuator/Micrometer: `bulk.queue.depth`, `bulk.flush.count`,
  `bulk.flush.docs`, `bulk.flush.latency`, `bulk.dropped`. Surfaced in the UI admin
  drawer; a live queue-depth number is persuasive evidence that the buffer is real
  and not decorative.
- **Alerts stay synchronous** (§7 step 6, D-13) — ~1/s, must be readable the instant
  they are published. The asymmetry is the point, not an oversight.

---

## Part 6 — Build order (vertical slices)

Resequenced from spec §8 so **every graded operation is complete and demo-ready at
the end of S9**, before any Neo4j or UI polish. Each slice ends in something
runnable and demonstrable.

### Phase A — Foundation
| # | Slice | Ends in | Cut? |
|---|---|---|---|
| **S0** | **`CLAUDE.md`** + repo skeleton + git init | The frozen file exists. **Nothing else starts first.** | **Never** |
| S1 | Docker Compose: redis, mongo (rs0 + initiator), neo4j, api | `GET /api/health` green on all three; `docker compose up` is one command | Never |
| S2 | Generator → `txn:stream`, partitioned entities (D-04), 12 cities | `XLEN`/`XRANGE` in `redis-cli` show well-formed entries at ~150/s | Never |
| S3 | Consumer group, idempotency guard, blocklist check, `XACK` last | Console prints scored-nothing transactions; kill -9 mid-run shows redelivery via `XPENDING` and **no** duplicates | Never |

### Phase B — The graded core *(the part the rubric marks)*
| # | Slice | Ends in | Cut? |
|---|---|---|---|
| **S4** | **Mongo write path**: validators, index registry (#1–#15), `MongoBulkWriter` | Transactions accumulate in Mongo at 150/s with flat queue depth; `db.transactions.getIndexes()` shows 6 | **Never** |
| S5 | Four detectors, scoring, severity bands, alerts written synchronously | Alerts appear in `db.alerts` with heterogeneous `rules[].evidence`; injectors fire all four | Never |
| **S6** | **Triage API — full CRUD**: manual create, status lifecycle, notes `$push`/`$pull`/`arrayFilters`, archive-then-delete, bulk delete, block-card write-back in an rs0 transaction, TTL index live | Every CRUD op exercised via `curl`/REST client; blocking a card visibly declines its next transactions in consumer logs | **Never** |
| **S7** | **Aggregations A–E** behind `/api/stats/*` | Each pipeline returns correct shapes against seeded data; verified in `mongosh` side by side | **Never** |
| **S8** | **`explain-evidence.mjs`** + `docs/evidence/` + README table + Neo4j `PROFILE` probe | `explain-report.md` generated, COLLSCAN→IXSCAN rows populated | **Never** |
| **S9** | **Minimal UI for the graded path**: triage queue, detail drawer (the `$lookup`), note composer, status control, block/dismiss, KPI strip (`$facet`), category + timeline charts, admin index drawer | ⛳ **GRADING GATE — CRUD, indexing and aggregation all demonstrable from the UI. If the project stopped here it would pass all three rubrics.** | Never |
| **S10** | **`seed.mjs`** — deterministic demo state incl. seeded ring | `--wipe && seed` reproduces an identical demo from cold in <60 s | Never |

### Phase C — The centrepiece
| # | Slice | Ends in | Cut? |
|---|---|---|---|
| S11 | Neo4j constraints + batched projector (`UNWIND`/`MERGE`) | Graph populates; verified in Neo4j Browser | Never |
| S12 | `RING_FOR_CARD` + `ALL_RINGS` + REST + ring cooldown + `ring_snapshots` | Ring injection produces a snapshot document with 6 cards | Never |
| S13 | Cytoscape ring panel + fcose layout | Ring renders on discovery (static layout) | Never |
| S14 | STOMP `/ws`, three channels, sampled `/topic/txn` (D-05), settlement tape | Live tape + live alert feed | Never |

### Phase D — Polish
| # | Slice | Ends in | Cut? |
|---|---|---|---|
| S15 | Edge-trace animation (600 ms), 120 ms print-in, fullscreen graph | §7.5/7.6 motion spec met | ✂️ **cut 3** |
| S16 | Rule-activity chart, all-rings panel | Secondary panels | ✂️ **cut 1** (spec §8 agrees) |
| S17 | Empty/loading/error states, `prefers-reduced-motion`, responsive <900px, contrast audit on `--text-mute`/`--panel` | §7.7 quality floor | ✂️ **cut 4** — but keep the contrast fix, it is 10 minutes |
| S18 | README, screenshots, screen recording, report appendix from §4, deck | §11 checklist complete | Never |

### Cut order under time pressure
1. **S16** — secondary panels (spec §8 already nominates these first).
2. Note edit/delete endpoints (`arrayFilters`, `$pull`) — keep `$push` notes; Update
   is still demonstrated by status lifecycle and blocking.
3. **S15** — animation. Keep the colour states; a static tape reads fine.
4. **S17** — responsive pass. The demo runs at one known projector resolution.
5. Pipeline C (top-cards) — the other four carry the aggregation rubric.

**Never cut:** S0, the whole of Phase B, and — per spec §8 — the ring query, the
graph panel, and the injectable ring pattern. The difference from the spec's cut
list is that Phase B is now protected, where the spec designated its MongoDB slice
as "the designated cut".

---

## Part 7 — Seed script (`scripts/seed.mjs`)

Purpose: the review demo must not depend on a live random stream having produced
anything interesting in the last five minutes. `node scripts/seed.mjs --wipe` yields
a byte-identical demo state from cold.

**Determinism:**
- Seeded PRNG (`mulberry32`, seed `0x5ENT1NEL`) — no `Math.random`, no `Date.now()`
  in data generation.
- All timestamps derived from `T0 = now` rounded down to the minute, then offsets in
  fixed deltas. Content is deterministic; only the absolute epoch shifts, which is
  required for the TTL-window caveat below.
- `ObjectId`s not relied upon for identity anywhere — `alertId` / `txnId` are the
  stable keys.
- Idempotent: re-running without `--wipe` upserts to the same state.

**Sequence:**
1. `POST /api/control/generator/pause` (D-15) — quiesce the stream first. If the API
   is down, proceed; the script talks to the stores directly.
2. `--wipe`: drop `sentinel` collections; `FLUSHDB` on Redis **except** re-seeding
   `blocklist:cards`; `MATCH (n) DETACH DELETE n` in Neo4j.
3. Recreate all §4.3 indexes and §4.4 constraints, then verify counts (15 / 4).
4. **50,000 transactions** across 500 cards / 80 merchants / 300 devices / 400 IPs /
   12 cities, spread over a synthetic 24 h ending at `T0`, with `ingestedAt` set
   *recent* so the 24 h TTL does not erase the seed mid-demo.
5. **2,000 alerts** with a deliberate distribution, not a uniform one:
   - severity 60% LOW / 30% MEDIUM / 10% HIGH — so the KPI `$facet` bands and the
     `$bucket` boundaries all have non-zero occupancy;
   - every rule type represented, including multi-rule alerts, so `byRule` and the
     `$reduce`/`$setUnion` in pipeline C both have real input;
   - spread across all minutes of the last hour so the timeline chart (B) is a
     populated area chart, not three spikes;
   - status mix: 40% NEW, 25% INVESTIGATING, 20% CONFIRMED_FRAUD, 15%
     FALSE_POSITIVE — so the triage queue filters are all non-empty and index #10 is
     actually exercised;
   - ~200 alerts carry 1–4 notes, so `$push`/`$slice` behaviour is visible;
   - merchant categories skewed so pipeline A produces a *ranked* bar chart with a
     clear leader, not twelve equal bars.
6. **The seeded ring** — the demo's insurance policy:
   - 6 cards `C-9001…C-9006`, shared device `D-SEED-01`, shared IPs
     `203.0.113.7` / `203.0.113.9`;
   - 40 transactions among them over the last 30 min;
   - written to Mongo **and** projected directly into Neo4j (`MERGE`, same shape the
     projector writes) so the ring query returns it without the live consumer having
     run;
   - one pre-built `ring_snapshots` document, so the graph panel renders a ring on
     first load with zero dependence on anything live;
   - `C-9001` left at `status: "NEW"` with a HIGH alert — the row to click during
     the demo.
7. **Triage fixtures:** 3 documents in `alerts_archive` (so the dismiss flow has
   history), 2 active rows in `blocked_cards` mirrored into Redis
   `blocklist:cards` — one of which is `C-9004`, a ring member, so the ring graph
   renders one node already marked blocked.
8. Warm Redis windows for `C-9001`: a partially-filled velocity ZSet and a
   `lastgeo` in Chennai — so the travel injector fires on the *first* injected
   transaction rather than needing a prior one.
9. `POST /api/control/generator/resume`.
10. Print a summary and **assert** it: counts per collection, index count, Neo4j node
    and relationship counts, Redis key count, blocklist members. Non-zero exit on
    mismatch — a seed script that silently half-works is worse than none.

`scripts/smoke.sh` then runs the graded path end to end (one create, one update, one
delete, one aggregation, one explain, one ring query) and exits non-zero on failure.
Run it before the demo; it is the five-second answer to "is everything up".

---

## Verification

**Per slice** — each has a concrete check in its table row above; a slice is not done
until that check passes.

**Graded path (run before the review, after `seed.mjs`):**

1. **Create** — UI "Raise case" on `C-9001`; `db.alerts.countDocuments()` +1.
2. **Read** — open the drawer; confirm `priorTxns` is populated (pipeline E) and
   `rules[].evidence` shows different shapes per rule.
3. **Update** — move status NEW → INVESTIGATING (check `statusHistory` grew), add a
   note (check `notes` grew), attempt an illegal transition (expect 409).
4. **Update across stores** — block `C-9002`; verify `redis-cli SISMEMBER
   blocklist:cards C-9002` → 1, and that the tape shows its next transactions
   `DECLINED`.
5. **Delete** — dismiss a `FALSE_POSITIVE`; count drops by 1, `alerts_archive`
   gains 1; then bulk-purge and point at `deletedCount`.
6. **Indexing** — open `docs/evidence/explain-report.md`; re-run one probe live via
   `GET /api/admin/explain?probe=P1` and show COLLSCAN→IXSCAN in front of them.
7. **Aggregation** — KPI strip refreshes; run pipeline D in `mongosh` beside the UI
   and show the same numbers.
8. **Ring** — inject ring; fan-out fires at card 3; graph resolves all 6; then run
   `RING_FOR_CARD` raw in Neo4j Browser (spec §9 step 6).
9. **Resilience** — `docker kill` the API mid-stream, restart, show `XPENDING`
   drained and no duplicate `txnId` in Mongo.

**Full rehearsal:** `docker compose down -v && docker compose up -d && node
scripts/seed.mjs --wipe && ./scripts/smoke.sh`, then §9's five-minute script at the
projector resolution, twice.

---

## Assumptions

1. **The spec lives at `Desktop/NoSQL Project.md`**, outside the project folder,
   which is currently empty. I will `git init` the project folder and copy the spec
   to `docs/NoSQL_Project.md`. The original is left untouched.
2. **No authentication.** Analyst identity is a dropdown of three canned names
   (`analyst.yash`, `analyst.dev`, `system`) sent as a request field. Real auth is
   out of scope for a NoSQL course project and would consume a slice.
3. **Single-node everything.** No Redis Cluster, no Mongo sharding, no Neo4j causal
   cluster. Sharding is answered as a viva question (shard key: `cardId` hashed —
   co-locates a card's history for the `{cardId, ts}` access pattern and avoids the
   monotonic-`ts` hot-shard), not implemented.
4. **Demo runs against the nginx build on port 3000**, not the Vite dev server.
5. **Windows host.** Compose, `.mjs` scripts and a PowerShell-friendly README; the
   `smoke.sh` fallback is `smoke.ps1`.
6. **Report and deck are out of scope** for the code plan except S18, which produces
   the artifacts they consume (§4 as appendix, evidence table, screenshots).
7. **"Everything" = full scope.** I have planned S0–S18 in full and marked the cut
   order as insurance only.

## Decisions to confirm before implementation starts

1. **Triage queue as a new primary panel.** The §7.4 layout has four regions and no
   room for a fifth. My plan tab-switches the alert-feed region between **Feed** and
   **Queue**, keeping the layout and the settlement tape intact. The alternative is a
   separate `/triage` route, which is cleaner but means the examiner navigates away
   from the live dashboard to see three of the four CRUD operations. **I recommend
   the tab.** Confirm, or say you would rather have the route.
2. **Seed volume 50,000 transactions.** Chosen so the `explain()` before/after gap is
   dramatic on a projector. It makes `seed.mjs` take ~30–60 s and the Mongo volume
   ~40 MB. If you would rather the seed be near-instant, say so and I will drop to
   10,000 — the COLLSCAN→IXSCAN shift still shows, just less starkly.
3. **`ENTITY_FANOUT` threshold stays at 3** (spec's figure), with the partitioning
   and windowing fixes from D-04 making it viable. If you would rather not change the
   generator's entity assignment, the alternative is raising the threshold to 4 — but
   then the ring injector's six cards trip it later and the demo beat lands softer.
   **I recommend the D-04 fix.**
4. **Detector weights** (VELOCITY 40 / AMOUNT 25 / TRAVEL 70 / FANOUT 55) are
   reverse-engineered from the §7.4 mock, which shows `HIGH IMPOSSIBLE_TRAVEL` and
   `MED VELOCITY`. If you have a different intuition about which rules are severe,
   these are the numbers to change — they are one line of `application.yml`, but the
   report quotes them.
5. **Gradle, not Maven.** Say if your course materials or your own habit expect
   Maven; it is a mechanical swap now and an annoying one later.
