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

### Resource limits (laptop-tuned; spec §11/§12 require these)
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
minutes and self-heal. This is the honest §10 viva answer, not a defect.

### Redis eviction
`maxmemory-policy noeviction`. **`allkeys-lru` is wrong here** because it would
silently evict `blocklist:cards` (a compliance control) and the consumer-group PEL
under pressure — breaking at-least-once delivery. Every volatile key carries an
explicit TTL (§4.1); memory is bounded by design, not by eviction. Under genuine
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
      generator/  consumer/  detect/  persist/  graph/  triage/  stats/  ws/  control/  admin/
      config/MongoIndexConfig.java      index registry, §4.3
      config/MongoValidatorConfig.java  JSON Schema, §4.2
  ui/                         React + Vite
  scripts/
    seed.mjs                  deterministic demo state
    explain-evidence.mjs      before/after harness
    smoke.sh / smoke.ps1
```

---

## §4 Data models — FROZEN

### §4.1 Redis key registry

Ports: `{c}` = cardId, `{d}` = deviceId, `{i}` = ip, `{t}` = txnId.
All times are epoch milliseconds. All TTLs are refreshed on write.

| Key | Type | TTL | Members / value | Written by | Read by |
|---|---|---|---|---|---|
| `txn:stream` | Stream | — | capped at **100000** (≈11 min @150/s), trimmed via periodic `XTRIM` every 500 writes¹ | generator | consumer group `fraud-detectors` |
| `idem:txn:{t}` | String | **900 s** | `"1"`, set `SET NX EX 900` | consumer step 2 | consumer step 2 |
| `card:{c}:txns` | ZSet | **3600 s** | score `ts`, member `{t}` | step 3 | VELOCITY |
| `card:{c}:amts` | ZSet | **3600 s** | score `ts`, member `"{t}|{amount}"` | step 3 | AMOUNT_ANOMALY |
| `card:{c}:geo` | GEO (ZSet) | **3600 s** | member `{t}` | step 3 | IMPOSSIBLE_TRAVEL (`GEODIST`), map panel |
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
3600 s (last 20 samples via `ZREVRANGE ... 0 19`), fan-out **600 s** (see §8 D-04).

**`txn:stream` entry fields** (flat, since `XADD` takes field-value pairs, not
nested JSON) — every producer (benign generator, and later the fraud injectors)
writes exactly this field set:

| Field | Example | Note |
|---|---|---|
| `txnId` | `T-M5F2K1-00001234` | boot-scoped run id + sequence, globally unique |
| `cardId` | `C-0417` | |
| `amount` | `4821.50` | string, 2dp |
| `currency` | `INR` | |
| `ts` | `1757858400000` | epoch millis, string |
| `merchantId` / `merchantName` / `merchantCategory` / `mcc` | | mirrors `transactions.merchant` (§4.2) |
| `city` / `lat` / `lon` | | one of the 12 cities, §4.6 |
| `deviceId` | `D-1042` | |
| `ip` | `49.207.14.88` | |
| `injected` | `false` | `true` for fraud-injector traffic; not persisted downstream, debugging aid only |

The consumer (§7) maps this directly onto the `transactions` document shape.

¹ Exact `XTRIM MAXLEN`, not the approximate `~` form — Spring Data Redis 3.3's
`StreamOperations` doesn't expose the `MapRecord` + `XAddOptions` overload cleanly
enough to trim inline on every `XADD`, so trimming runs as a separate periodic
call instead. At this scale (100k cap) the O(log N) cost difference between exact
and approximate trimming is immaterial.

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
fraud-rate-by-category pipeline (§5 A) would otherwise need a `$lookup` from
`alerts` on every KPI refresh. This is read-optimised denormalisation, the
document-model counterpart to a materialised view.

#### `alerts` — the triage document
```json
{
  "_id": ObjectId("..."),
  "alertId": "A-0000091",             // human-quotable, unique
  "txnId": "T-000000123",             // join key to transactions; null for ANALYST-origin alerts (§8 D-22)
  "cardId": "C-0417",
  "ts": ISODate("..."),
  "severity": "HIGH",                 // LOW | MEDIUM | HIGH
  "score": 95,                        // 0..100
  "origin": "DETECTOR",               // DETECTOR | ANALYST  (analyst = manual Create)

  "rules": [                          // heterogeneous — the reason alerts are documents
    { "type": "VELOCITY", "weight": 40,
      "evidence": { "count": 12, "windowSec": 60, "threshold": 5 } },
    { "type": "IMPOSSIBLE_TRAVEL", "weight": 70,
      "evidence": { "fromCity": "Chennai", "toCity": "Delhi", "km": 1756.3,
                    "seconds": 2.0, "impliedKmh": 3162000.0, "threshold": 900 } }
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
the validator explicitly permits any object there. This is the spec §3/§9-step-7
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
insurance policy for spec §9 step 5.

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
| 16 | alerts_archive | `{ originalId: -1 }` | single | `AlertWriter`'s alertId counter reseed (§8 D-23) |

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
`count` instead. This is the spec §10 viva answer.

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

Calibrated so the spec §7.4 mock is truthful: `IMPOSSIBLE_TRAVEL` alone → HIGH,
`VELOCITY` alone → MEDIUM, `ENTITY_FANOUT` alone → MEDIUM, fan-out + velocity → 95
HIGH. No rule alone lands in LOW, so LOW means "one weak rule plus noise" — which is
what it should mean.

### Injectable patterns (spec §5, corrected per §8 D-02/D-03)
| Endpoint | Behaviour |
|---|---|
| `POST /api/control/inject/velocity` | one card, **12 txns in 20 s** (threshold is 5/60 s) |
| `POST /api/control/inject/travel` | Chennai → Delhi, **2 s** real gap → ~3,168,000 km/h (§8 D-21) |
| `POST /api/control/inject/ring` | **6** cards onto shared device `D-SEED-01` + 2 IPs, staggered 2 s |
| `POST /api/control/generator/pause` | pause benign traffic (added — deterministic demo) |
| `POST /api/control/generator/resume` | resume |

Fan-out fires at the **3rd** card, ~6 s in — before all six have transacted. The
ring query then returns all six as they arrive. Narrate it that way: Redis notices
early and partially; Neo4j resolves the whole group.

### Baseline traffic — population and pacing (§8 D-19)

Same failure class as the fan-out bug (D-04), on the *other* detector: at the
spec's **500 cards** and **150 txn/s**, a generator picking cards uniformly at
random gives a mean of **18 transactions per card per 60 s window** — 3.6× the
VELOCITY threshold of 5/60s. Baseline traffic would trip VELOCITY constantly,
which is worse than the fan-out bug because VELOCITY is the *first* pattern
demoed (spec §9 step 2). Fixed the same way D-04 fixed fan-out: a **structural**
guarantee, not a probabilistic one.

**The fix has two parts, both required together:**

1. **Hard per-card cooldown.** The benign generator enforces a minimum **20 s**
   gap between any two transactions on the same card (injected fraud patterns
   deliberately bypass this — that is what makes them fraud). A hard 20 s floor
   makes the maximum possible count in *any* 60 s window exactly **4**
   (transactions at t, t+20, t+40, t+60 span 60 s; a 5th needs t+80) —
   structurally below the threshold of 5, not just unlikely to reach it.
2. **Card pool sized to sustain throughput under that cooldown.** A 20 s
   per-card floor caps single-card throughput at 0.05 txn/s, so sustaining
   150 txn/s in aggregate needs at minimum `150 × 20 = 3,000` cards with an
   eligible (off-cooldown) card available at every tick. Below that minimum the
   generator stalls waiting for a free card and true throughput sags below 150.

**Population, corrected:**

| Entity | Spec figure | Corrected | Why |
|---|---|---|---|
| Cards | ~500 | **4,000** | ≥3,000 required by the cooldown; slack avoids generator stalls finding an eligible card |
| Devices | ~200 → 300 (D-04) | **2,200** | ≥2,000 required to hold the D-04 cap of ≤2 cards/device at 4,000 cards |
| IPs | ~300 → 400 (D-04) | **3,200** | ≥2,600 required to hold ≤2 cards/IP at ~1.3 home IPs/card average |
| Merchants | ~80 | **80**, unchanged | Not in the `ENTITY_FANOUT` scope (§4.1 tracks `device:{d}:cards` / `ip:{i}:cards` only, no merchant key) — no threshold interaction exists |

**IP fan-out was also unaddressed by D-04.** D-04's prose capped devices at ≤2
cards but did not say the same for IPs, even though `ip:{i}:cards` feeds the same
`ENTITY_FANOUT` detector as `device:{d}:cards` (§4.1). Corrected here: IPs get
the identical ≤2-cards-per-IP structural cap at assignment time.

**Travel safety, for completeness:** each card is assigned one fixed home city;
baseline transactions never leave it. `IMPOSSIBLE_TRAVEL` has zero baseline
exposure by construction — no probabilistic argument needed, since there is
nothing to compute a cross-city speed from. Only the travel injector (§5, which
targets one card deliberately) produces a city change.

`sentinel.generator.*` in `application.yml` is the authoritative source for
these counts; this table exists so the reasoning survives a config-file skim.

---

## §6 API surface

`/api/txns` · `/api/alerts` · `/api/cards` · `/api/rings` · `/api/stats` ·
`/api/control` · `/api/admin`. Full triage and stats routes: see the implementation
plan (`docs/PLAN.md` if exported, else the session's plan file) Parts 4–5, and
`README.md` once written.

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
 │                       → if member: mark txn.declined = true; skip detectors (4);
 │                         still persist (5) and still XACK (10).
 │
 2. IDEMPOTENCY GUARD    SET idem:txn:{txnId} 1 NX EX 900
 │                       → if NOT acquired: this is a redelivery already processed.
 │                         XACK and return. No side effects repeated.
 │
 3. WINDOW UPDATES       pipelined, single round trip:
 │                       ZREMRANGEBYSCORE (trim) ×4
 │                       ZADD card:{c}:txns / :amts · GEOADD card:{c}:geo
 │                       ZADD device:{d}:cards / ip:{i}:cards
 │                       INCR metrics:txn:{epochMin} · EXPIRE all
 │
 4. EVALUATE DETECTORS   4 rules, pure functions over the window reads → score, band
 │
 5. PERSIST TRANSACTION  → MongoBulkWriter buffer (non-blocking, §ref implementation
 │                         plan Part 5). NOT insertOne. Flush on 200 docs or 500 ms.
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
| D-01 | 2026-09-14 | Throughput is **150 txn/s**; the spec §7.4 mock's `1,284 txn/s` is placeholder | Two figures in the spec; the abstract and architecture both say 150. KPI strip shows the live measured rate. |
| D-02 | 2026-09-14 | Velocity **injector = 12 txns / 20 s**; velocity **threshold = 5 / 60 s** | Spec §5 and §9 disagreed because they described different things. Both kept, stated separately. |
| D-03 | 2026-09-14 | Impossible-travel narration corrected to **26,400 km/h**; threshold **900 km/h** | Spec §9 quoted the Chennai–Delhi *distance* (1,760 km) as a *speed*. 1,760 km in 4 min is 26,400 km/h. |
| D-04 | 2026-09-14 | Benign entity assignment **partitioned** (≤2 cards/device) and fan-out **windowed to 600 s** | 500 cards / 200 devices gave mean fan-out 2.5 against a threshold of 3 — baseline traffic would have alerted continuously and buried the ring demo. |
| D-05 | 2026-09-14 | `/topic/txn` **sampled to ~8 msg/s**; flagged txns always published | 150 rows/s against spec §7.5's 120 ms print-in is 18 s of animation per second. Ingestion rate and display rate are now separate concerns. |
| D-06 | 2026-09-14 | Two ring queries defined: `RING_FOR_CARD`, `ALL_RINGS` | Spec referred to "both ring queries" without ever writing either. |
| D-07 | 2026-09-14 | MongoDB persistence moved from Slice 6 (Week 4) to **Slice 4** | Spec §4's consumer writes to Mongo at step 4 from the first slice; §8 scheduled that code three weeks later. Also required by the grading rubric. |
| D-08 | 2026-09-14 | **Alert triage workflow** added as a first-class feature | Spec had no Update and no Delete. Triage supplies both from the UI, and the block-card write-back closes a Mongo→Redis loop that strengthens the design argument. |
| D-09 | 2026-09-14 | Dismissal is **archive-then-hard-delete** | Rubric needs a real `deleteOne`/`deleteMany` with a visible count drop; the archive copy keeps the audit answer defensible. |
| D-10 | 2026-09-14 | MongoDB runs as a **single-node replica set** (`rs0`) | Enables a real multi-document transaction for the block-card write-back, and makes the change-streams viva answer "available, and here is why I still did not use it". |
| D-11 | 2026-09-14 | Transactions **denormalise** `flagged` and `score` | Avoids a `$lookup` on every KPI refresh. Read-optimised denormalisation is the document-model idiom; state it rather than apologise for it. |
| D-12 | 2026-09-14 | Redis `maxmemory-policy noeviction`, every volatile key TTL'd | `allkeys-lru` could evict `blocklist:cards` (a compliance control) and the PEL (breaking at-least-once). Answers the §10 viva question directly. |
| D-13 | 2026-09-14 | Alerts written **synchronously**, transactions **buffered** | 150:1 volume ratio; alerts are the durable record and must be readable the instant they are published to the UI. |
| D-14 | 2026-09-14 | Raw transactions **TTL 24 h**; alerts kept indefinitely | Hot/cold split. Alerts self-contain their evidence, so an expired transaction does not orphan an alert. |
| D-15 | 2026-09-14 | Added `POST /api/control/generator/pause` | The seed script needs a quiescent stream to produce a deterministic demo state. |
| D-16 | 2026-09-14 | Triage queue is a **tab** in the alert-feed region, not a separate route | Keeps the graded CRUD path inside the live dashboard the examiner is already looking at, rather than requiring navigation away from it. Recommendation accepted by default; revisit if it crowds the layout. |
| D-17 | 2026-09-14 | Seed volume **50,000 transactions / 2,000 alerts** | Needed so the `explain()` before/after gap (COLLSCAN → IXSCAN) is visually obvious on a projector; at a few hundred docs the timing difference is noise. |
| D-18 | 2026-09-14 | Gradle (not Maven) for the API build | Default choice; mechanical to swap later if needed. |
| D-19 | 2026-09-14 | Card pool **500 → 4,000**; devices **→ 2,200**; IPs **→ 3,200**; hard **20 s per-card cooldown** in the benign generator | Same bug class as D-04, on VELOCITY instead of fan-out: 500 cards at 150 txn/s gives a mean of 18 txns/card/60s against a threshold of 5. A structural cooldown plus a pool sized to sustain throughput under it removes the failure mode entirely rather than reducing its odds. Also closes a gap D-04 left open: IPs get the same ≤2-cards cap as devices. See §5 "Baseline traffic — population and pacing". |
| D-20 | 2026-09-14 | Dropped `card:{c}:lastgeo`; IMPOSSIBLE_TRAVEL reads the two most recent members of `card:{c}:txns` (`ZREVRANGE ... 0 1 WITHSCORES`) and calls `GEODIST` on `card:{c}:geo` between them | `lastgeo` as specified is unimplementable against the frozen §7 order: step 3 (write) runs before step 4 (read), so an unconditional overwrite in step 3 means step 4 only ever sees the *current* point — the detector would silently never fire. The ZSet-based fix has no such ordering hazard (both points already exist in the sorted set by read time) and — better — it is a literal `GEODIST` call, matching the spec §9 narration ("that's `GEODIST` between the last two points") more directly than parsing a string and computing haversine distance by hand would have. |
| D-21 | 2026-09-14 | Travel injector's second leg uses a **real** ~2 s wall-clock gap, not a simulated 4-minute future `ts` | Caught live: a future `ts` on leg 2 makes step 3's *own* trim floor (`ts − windowSeconds`) for that same write treat everything at real "now" — including leg 1 — as outside the window, so leg 1 gets evicted by leg 2's own window update before step 4 ever compares them; no alert fired. Worse, the future-scored entry then sits as "most recent by score" for the real 4 minutes that follow, silently liable to pair with *later*, unrelated organic traffic on that card. The windowing model assumes `ts ≈ real time` everywhere (every TTL, every trim floor, every detector); injecting a value that violates that assumption corrupts shared state, not just the one detector it was aimed at. Fix: real ~2 s gap. It is *more* dramatic for the demo (~3,168,000 km/h implied over ~1,760 km, not 26,400), not less, and every other timestamp in the system keeps meaning what it says. |
| D-22 | 2026-09-14 | `alerts.txnId` is nullable in the validator (`bsonType: ["string","null"]`) | A manual, analyst-raised alert (Create, triage) has no single triggering transaction to anchor to — that is the whole point of it. The original schema declared `txnId` strictly `"string"`, which would reject the natural `null` value on insert. Pipeline E's `$lookup` already handles a missing match gracefully (`preserveNullAndEmptyArrays`), so nothing downstream needed to change, only the validator. |
| D-23 | 2026-09-14 | Index **#16** added: `alerts_archive { originalId: -1 }`. `AlertWriter`'s counter now seeds from the max issued alertId (via this index), not `countDocuments()`. `MongoValidatorConfig` now runs `collMod` on every boot, not just `createCollection` on first boot | Two bugs caught live in the same test session. (1) `countDocuments()` undershoots badly once anything is ever deleted — after deleting most test alerts, the counter restarted near zero while thousands of already-issued ids still sat ahead of it, so every insert collided repeatedly until the (then 3-attempt) retry budget was exhausted outright, not just occasionally bumped. Seeding from the true max (across both `alerts` and its archive) fixes this at the source; the retry budget is raised to 10 anyway as cheap insurance. (2) The `alerts.txnId` nullability fix (D-22) silently didn't take effect on the already-existing `alerts` collection, because the validator was only ever applied at `createCollection` time — `collMod` on every boot makes it self-healing instead of requiring a manual `docker compose down -v` after every schema edit. |

---

*End of frozen document. All application code that follows must agree with this
file; any drift is a bug in the code, not license to reinterpret the schema.*
