# SentinelStream — presentation source material

This file is the single source of facts for the SentinelStream review deck. It
contains the theory for each evaluation criterion, the measured evidence, a
manifest of the 19 image files that accompany it, and a slide-by-slide
storyboard.

Everything here was taken from the running system or its source code on
13 October 2026. Do not add facts, figures, features or names that are not in
this file.

**Project:** SentinelStream — Real-Time Card Fraud Detection and Fraud-Ring
Discovery Using Polyglot NoSQL Persistence
**Course:** NoSQL Databases — Course Project
**Author:** Yash Sehrawat · 23BCE0161 · VIT Vellore
*(If there are other team members, the presenter will add them on the title slide.)*

**Evaluation criteria the deck must address, in this order:**
1. System Design
2. Database Implementation
3. Query Quality
4. Prototype / Demo
5. Documentation & Progress

---

## Part 0 — The project in one paragraph

SentinelStream scores a live stream of about 150 synthetic card transactions a
second for fraud. It has two jobs that pull in opposite directions: decide
about every transaction within milliseconds using only recent in-memory state,
and find organised fraud, where one device runs many stolen cards and no single
transaction looks suspicious. No one data model serves both. Redis ingests the
stream and holds the sliding-window state the four detectors read. MongoDB is
the system of record for transactions and alerts and runs the analyst workflow
and the statistics. Neo4j holds the graph of cards, devices and IPs and resolves
a fraud ring in a single traversal. A Spring Boot API ties them together and a
React dashboard shows it live.

**The thesis in one sentence:** the three stores are not interchangeable; each
is used because the access pattern it serves is native to its data model and
awkward in the other two.

---

## Part 1 — System Design

### 1.1 Problem statement

Given a continuous stream of card transactions, the system must:

1. Score every transaction against behavioural rules within the stream's
   arrival budget, using only in-memory state.
2. Keep per-card state over a sliding window without unbounded memory growth.
3. Detect coordinated fraud: cards linked through shared devices or network
   origins, where no single transaction is suspicious.
4. Keep transaction and alert history for investigation, tolerating an alert
   payload whose shape varies by which rules fired.
5. Show all of this to an operator in real time.

### 1.2 Why three databases (polyglot persistence)

| Requirement | Store | Why this model, and why not the others |
|---|---|---|
| Ordered, replayable ingestion with redelivery | **Redis Streams** | An append-only log with per-consumer acknowledgement and a pending list. A relational queue table needs polling and locking; plain Pub/Sub loses messages when the consumer is down. |
| Sliding-window counts, rolling averages, distance between points | **Redis sorted sets and GEO** | The score is the timestamp, so a window is trimmed by score and counted in constant time. The SQL equivalent is a `COUNT(*)` with a time predicate on every transaction. |
| Alerts with evidence that differs per rule; transaction history; analyst workflow | **MongoDB** | Each alert carries an array of rule objects whose fields differ by rule type. A relational schema needs a sparse wide table or a key-value side table and a join. |
| Multi-hop ring discovery across cards, devices and IPs | **Neo4j** | A ring is a connected group of unknown depth. Cypher expresses it as one variable-length pattern; SQL needs a recursive self-join whose cost grows with depth. |

**The honest counter-argument, stated up front:** at this volume a single
PostgreSQL instance with JSONB, a recursive CTE and materialised counters could
do all of it. The polyglot design earns its complexity under high volume and
tight latency budgets, and costs operational overhead in return.

### 1.3 Architecture

Figure: `fig-01-architecture.png`.

Five processes run on one machine, all bound to localhost:

| Process | Port | Role |
|---|---|---|
| Redis 7.2 | 6379 | Stream ingestion, sliding windows, blocklist, Pub/Sub |
| MongoDB 7.0 (single-node replica set `rs0`) | 27017 | System of record |
| Neo4j 5.20 | 7687 (Bolt), 7474 (Browser) | Entity graph |
| Spring Boot 3.3 API, Java 21 | 8080 | Generator, stream consumer, detectors, REST, WebSocket |
| React 18 dashboard (Vite) | 3000 | User interface |

Design principles that shaped the architecture:

- **Nothing blocking on the hot path.** Between reading a transaction and
  acknowledging it there is no Neo4j write, no per-transaction MongoDB insert
  and no ring query. Those go through bounded in-memory queues or a background
  thread.
- **Acknowledge last.** `XACK` is always the final step, so a crash anywhere
  earlier results in redelivery, not loss.
- **Deterministic, explainable rules.** No machine learning. Every alert stores
  the exact numbers that triggered it.
- **Every MongoDB query on a request path is backed by a declared index.**
- **Memory is bounded by design.** Every temporary Redis key has a TTL; raw
  transactions expire after 24 hours.

MongoDB runs as a replica set, even with one node, because multi-document
transactions require one, and blocking a card updates two collections together.

### 1.4 The life of one transaction: the ten-step consumer

Figure: `fig-02-pipeline.png`. The order is fixed in the code
(`consumer/TransactionConsumer.java`).

| # | Step | Store | Command | Why |
|---|---|---|---|---|
| 1 | Blocklist check | Redis | `SISMEMBER blocklist:cards` | A blocked card is marked declined and skips the detectors |
| 2 | Idempotency guard | Redis | `SET idem:txn:{id} 1 NX EX 900` | A repeated delivery is acknowledged and dropped |
| 3 | Update windows | Redis | `ZREMRANGEBYSCORE`, `ZADD`, `GEOADD`, `EXPIRE` (one pipeline) | Trims and updates five windows in one round trip |
| 4 | Run four detectors | Redis | `ZCARD`, `ZREVRANGE`, `GEODIST` | Produces a score from 0 to 100 |
| 5 | Save transaction | MongoDB | `bulkWrite`, upsert on `txnId` | Buffered: 200 documents or 500 ms |
| 6 | Save alert | MongoDB | `insertOne` | Immediate, only if the score is above 0 |
| 7 | Queue graph edges | Neo4j | `UNWIND $batch … MERGE` | Buffered: 100 edges or 500 ms |
| 8 | Ring query | Neo4j | `MATCH … *1..6` | Only if fan-out fired; background thread; 300 s cooldown per card |
| 9 | Publish | Redis | `PUBLISH alerts:live` | Relayed to the dashboard over a WebSocket |
| 10 | Acknowledge | Redis | `XACK` | Always last |

Two deliberate asymmetries:

- **Transactions are buffered, alerts are not.** Transactions arrive at 150 a
  second; alerts are rare, are the durable record, and must be readable the
  instant they are announced to the dashboard.
- **The ring query waits one second.** Step 7 only queues the edge, so the ring
  query runs two flush intervals later, once Neo4j actually knows about the link
  that triggered it.

Delivery guarantee: at-least-once delivery from the stream, made safe to repeat
by the idempotency key and by the unique index on `txnId`.

### 1.5 The four detection rules

| Rule | Fires when | Redis read | Points |
|---|---|---|---|
| Velocity | 5 or more transactions on one card within 60 s | `ZCARD` on `card:{id}:txns` | 40 |
| Amount anomaly | Amount above mean + 3σ of the card's last 20 amounts (needs at least 5) | `ZREVRANGE` on `card:{id}:amts` | 25 |
| Impossible travel | Implied speed above 900 km/h across at least 200 km | `GEODIST` between the card's last two points | 70 |
| Entity fan-out | One device or one IP used by 3 or more cards within 600 s | `ZCARD` on `device:{id}:cards` / `ip:{ip}:cards` | 55 |

Score = sum of the points of every rule that fired, capped at 100.
**Low** 1–39, **Medium** 40–69, **High** 70–100.

Worked examples: impossible travel alone is 70, High. Fan-out plus velocity is
95, High. Amount anomaly alone is 25, Low.

**Keeping normal traffic innocent.** Synthetic traffic must not trip the rules
by accident, or real demonstrations drown in noise. Each rule has a structural
guarantee in the generator, not a statistical hope:

| Rule | Guarantee in the generator |
|---|---|
| Velocity | A card waits at least 20 s between payments, so at most 4 fall in any 60 s. The limit is 5. |
| Entity fan-out | Every device and every IP is shared by at most 2 cards. The limit is 3. |
| Impossible travel | Every card has one home city and never leaves it. |
| Amount anomaly | Every card has a typical spend and stays within ±40% of it, and is capped at mean + 2.5σ of its own history. About 1 payment in 3,000 is a deliberate overspend. |

Population: 4,000 cards, 2,200 devices, 3,200 IPs, 80 merchants, 12 Indian
cities with real coordinates.

### 1.6 The Redis to Neo4j handoff

Figure: `fig-06-ring-handoff.png`. This is the moment the design exists for.

1. **Redis notices.** Six cards start paying from one device, two seconds apart.
   The device's sorted set reaches three cards and Entity fan-out fires.
   Redis knows a device is crowded; it cannot say who else is connected.
2. **Neo4j resolves.** One traversal from the flagged card follows device and IP
   links up to six hops and keeps only the entities shared by two or more cards.
3. **MongoDB remembers.** The ring is saved to `ring_snapshots` as it was found.
4. **The analyst sees it.** The snapshot is published and the dashboard shows
   "Fraud ring discovered".

Measured on a live injection: four snapshots were saved as the cards arrived,
showing the injected device with 3, then 4, then 5, then all 6 cards.

*(The card and device ids inside `fig-06` are illustrative. The sequence and the
thresholds are real.)*

---

## Part 2 — Database Implementation

Figure for the whole part: `fig-03-data-model.png`.

### 2.1 Redis: keys designed per access pattern

| Key | Type | TTL | Holds | Answers |
|---|---|---|---|---|
| `txn:stream` | Stream | capped at 100,000 | incoming transactions | what arrived, in order |
| `idem:txn:{id}` | String | 900 s | "1" | has this been processed? |
| `card:{id}:txns` | Sorted set | 3600 s | transaction ids, score = time | how many in the last 60 s |
| `card:{id}:amts` | Sorted set | 3600 s | `txnId|amount`, score = time | what is this card's usual amount |
| `card:{id}:geo` | GEO | 3600 s | location per transaction | how far apart were the last two |
| `device:{id}:cards` | Sorted set | 1800 s | card ids, score = time | how many cards on this device |
| `ip:{ip}:cards` | Sorted set | 1800 s | card ids, score = time | how many cards from this IP |
| `blocklist:cards` | Set | none | blocked card ids | is this card blocked? |
| `ring:cooldown:{id}` | String | 300 s | "1" | was a ring queried for it lately? |
| `metrics:txn:{minute}` | String | 300 s | counter | live rate |
| `alerts:live`, `rings:live` | Pub/Sub | — | JSON | live notifications |

Implementation decisions:

- **A sorted set, not a list.** The score is the timestamp, so
  `ZREMRANGEBYSCORE` trims the window and `ZCARD` counts it in constant time.
  Adding the same card twice only moves its score, so for fan-out the count is
  already the number of *distinct* cards.
- **Persistence:** append-only file, flushed every second, no snapshots. After
  a crash at most one second is lost; windows are short and refill themselves.
- **Eviction policy `noeviction`.** `allkeys-lru` could silently delete the
  blocklist or the stream's pending list. Memory is bounded by TTLs instead.
- **`blocklist:cards` is the only key without a TTL**, because it records an
  analyst's decision and must survive a restart.
- **Pooled connections.** Each pipelined update needs a dedicated connection.
  Unpooled, that was one TCP connection per transaction, which exhausted the
  operating system's ports within two minutes; a pool of 16 fixed it.

Live evidence from the running system:

```
> XINFO GROUPS txn:stream
name fraud-detectors  consumers 1  ...
> SMEMBERS blocklist:cards
C-9004, C-0500, C-0366
> TTL blocklist:cards
-1                         (no expiry)
> TYPE card:C-0100:txns
zset
> TTL card:C-0100:txns
3476                       (seconds remaining)
> ZRANGE card:C-0100:amts -3 -1 WITHSCORES
T-MV6XBKEC-00079739|499.7     1791911159367
T-MV6XBKEC-00082928|404.48    1791911180656
T-MV6XBKEC-00087582|278.89    1791911211659
> CONFIG GET maxmemory-policy
noeviction
```

### 2.2 MongoDB: documents shaped by how they are read

Database `sentinel`, five collections, each with a `$jsonSchema` validator
(`validationLevel: moderate`, `validationAction: error`).

| Collection | One document is | Retention | Validator |
|---|---|---|---|
| `transactions` | one card payment | 24 hours (TTL index) | 14 properties |
| `alerts` | one alert with its whole case history | indefinite | 15 properties |
| `alerts_archive` | a dismissed alert | 7 days (TTL index) | 7 properties |
| `blocked_cards` | one block: who, when, why | indefinite | 7 properties |
| `ring_snapshots` | one ring as it was found | indefinite | 8 properties |

**A real alert document from the running system** (after an analyst moved it to
Investigating, added a note and assigned it):

```json
{
  "alertId": "A-9000024",
  "txnId": "T-MV6XBKEC-00063412",
  "cardId": "C-0170",
  "ts": "2026-10-13T17:04:10.617Z",
  "severity": "HIGH",
  "score": 70,
  "origin": "DETECTOR",
  "rules": [
    { "type": "IMPOSSIBLE_TRAVEL", "weight": 70,
      "evidence": { "fromCity": "Chennai", "toCity": "Delhi", "km": 1756.3,
                    "seconds": 2, "impliedKmh": 3125385.1, "threshold": 900 } }
  ],
  "status": "INVESTIGATING",
  "assignee": "analyst.dev",
  "notes": [
    { "noteId": "n-7b6f292c", "author": "analyst.yash",
      "body": "Called the cardholder: they are in Chennai and did not travel. Escalating.",
      "at": "2026-10-13T17:04:47.517Z", "editedAt": null }
  ],
  "statusHistory": [
    { "from": null,  "to": "NEW",           "by": "system",       "at": "2026-10-13T17:04:10.633Z" },
    { "from": "NEW", "to": "INVESTIGATING", "by": "analyst.yash", "at": "2026-10-13T17:04:45.704Z" }
  ],
  "cardBlocked": false,
  "resolution": null
}
```

**The four evidence shapes, each from a real alert.** This is the reason alerts
are documents:

```json
VELOCITY          { "count": 15, "windowSec": 60, "threshold": 5 }
AMOUNT_ANOMALY    { "amount": 7046.61, "mean": 2264.12, "stddev": 449.69,
                    "sigma": 3, "threshold": 3613.19, "sampleSize": 20 }
IMPOSSIBLE_TRAVEL { "fromCity": "Chennai", "toCity": "Delhi", "km": 1756.3,
                    "seconds": 2, "impliedKmh": 3125385.1, "threshold": 900 }
ENTITY_FANOUT     { "windowSec": 600, "threshold": 3, "deviceId": "D-INJ-CF5A332E",
                    "deviceCardCount": 6, "ip": "10.20.228.125", "ipCardCount": 3 }
```

**A real transaction document:**

```json
{ "txnId": "T-MV6XBKEC-00023424", "cardId": "C-1220", "amount": 4183.06, "currency": "INR",
  "ts": "2026-10-13T16:59:44.068Z",
  "merchant": { "id": "M-044", "name": "SkyBook 4", "category": "TRAVEL", "mcc": "4722" },
  "city": "Ahmedabad",
  "loc": { "type": "Point", "coordinates": [72.5714, 23.0225] },
  "deviceId": "D-1331", "ip": "87.20.156.202",
  "flagged": true, "score": 25, "declined": false,
  "ingestedAt": "2026-10-13T16:59:44.087Z" }
```

Schema decisions specific to the document model:

| Decision | What was done | Why |
|---|---|---|
| Embed, do not join | `rules[]`, `notes[]` and `statusHistory[]` live inside the alert | They belong to one alert and are always read with it |
| Polymorphic sub-document | `rules[].evidence` has no fixed shape; the validator explicitly allows any object there | Each rule proves something different |
| Denormalise for reads | `flagged` and `score` are copied onto each transaction | The fraud-rate-by-category pipeline then needs no join on every refresh |
| Bounded arrays | Notes are written with `$push` + `$slice: -50` | An array that grows without limit is the classic document-model trap |
| Reference where lifetimes differ | `alerts.txnId` points to `transactions.txnId` | Transactions expire after 24 hours; alerts do not |
| Hot / cold split | TTL index on transactions; alerts keep their own evidence copy | An expired transaction never orphans an alert |
| GeoJSON | `loc` is a `Point` with a `2dsphere` index | Native geographic queries |
| Nullable foreign key | `alerts.txnId` may be null | A manually raised case has no triggering transaction |

### 2.3 CRUD operations (all four, each reachable from the dashboard)

| Operation | In the dashboard | MongoDB call | Screenshot |
|---|---|---|---|
| **Create** | Triage → Raise case | `insertOne` into `alerts`, `origin: "ANALYST"` | `shot-06-crud-create.png` |
| **Read** | The triage queue; opening an alert | `find` with filters, sort and paging; an aggregation with three `$lookup` stages | `shot-04-triage-index-scan.png`, `shot-03-alert-evidence.png` |
| **Update** | Change status, assign, add / edit / delete a note | `findOneAndUpdate` with `$set`, `$push` + `$slice`, `$pull`, and `arrayFilters` for editing one note | `shot-07-crud-update.png` |
| **Delete** | Dismiss one alert; Clear false positives | copy to `alerts_archive`, then `deleteOne` / `deleteMany` | `shot-08-crud-delete.png` |

REST surface for CRUD:

```
GET    /api/alerts?status=&severity=&cardId=&rule=&page=&size=
GET    /api/alerts/{alertId}
POST   /api/alerts/manual
PATCH  /api/alerts/{alertId}/status
PATCH  /api/alerts/{alertId}/assign
POST   /api/alerts/{alertId}/notes
PATCH  /api/alerts/{alertId}/notes/{noteId}
DELETE /api/alerts/{alertId}/notes/{noteId}
DELETE /api/alerts/{alertId}?reason=&by=
DELETE /api/alerts?status=FALSE_POSITIVE&by=
POST   /api/cards/{cardId}/block        DELETE /api/cards/{cardId}/block
```

Integrity rules enforced on the server:

- A status change is made with a filter on the status that was read, so a
  concurrent change loses cleanly instead of overwriting.
- An illegal status move is rejected with `409 Conflict`.
- Resolving as Confirmed fraud or False positive requires a written resolution.
- Only New or False positive alerts can be dismissed. Confirmed fraud cannot.
- Deletion is archive-then-delete: the alert is copied to `alerts_archive`
  (kept 7 days) and then really deleted.

### 2.4 Alert lifecycle and the cross-store write

Figure: `fig-04-lifecycle-block.png`.

Lifecycle: New → Investigating → Confirmed fraud **or** False positive; either
can be reopened to Investigating. Every change appends
`{from, to, by, at}` to `statusHistory`.

**Blocking a card: one action, three stores.**

1. The analyst chooses Block card. `POST /api/cards/{cardId}/block`.
2. **MongoDB**, in one multi-document transaction: upsert into `blocked_cards`
   and set `cardBlocked` on that card's alerts. Both commit or neither does.
3. **Redis**, only after the commit: `SADD blocklist:cards {cardId}`.
4. **Neo4j**, best effort: `SET c.blocked = true`, so the graph draws it red.
5. The card's next payment hits consumer step 1, is marked declined, and
   appears struck through on the live tape.

MongoDB is the record of truth; Redis is the copy the hot path reads.
Screenshot of the result: `shot-09-block-declined.png`. Cards `C-0366` and
`C-0500` are blocked; every later payment on them is declined.

### 2.5 Neo4j: entities and how they connect

Nodes: `Card {cardId}`, `Device {deviceId}`, `Ip {ip}`.
Relationships: `(:Card)-[:USED_DEVICE {count}]->(:Device)` and
`(:Card)-[:FROM_IP {count}]->(:Ip)`.

Live counts: 4,006 cards, 2,002 devices, 3,096 IPs; 4,012 `USED_DEVICE` and
5,205 `FROM_IP` relationships.

| Decision | Reason |
|---|---|
| Transactions are **not** nodes | A transaction is an event, not an entity. At 150 a second that would be about 13 million nodes a day that nothing traverses. The relationship carries a `count` instead. |
| `MERGE`, never `CREATE` | Processing a transaction twice increments a counter instead of creating a duplicate relationship. |
| Batched writes with `UNWIND` | One round trip writes up to 100 edges; never a synchronous write per transaction. |
| Uniqueness constraints on `cardId`, `deviceId`, `ip`, `merchantId` | Each also creates an index, so the starting card of a traversal is found by a seek. |
| Direction is always card → entity | Uniform direction keeps the pattern simple. |

Live constraints:

```
"card_id"    UNIQUENESS  ["Card"]      ["cardId"]
"device_id"  UNIQUENESS  ["Device"]    ["deviceId"]
"ip_addr"    UNIQUENESS  ["Ip"]        ["ip"]
"merch_id"   UNIQUENESS  ["Merchant"]  ["merchantId"]
```

*(The schema also defines a `Merchant` node and a `PAID` relationship. The live
system does not write them; ring detection needs only devices and IPs. See
Part 6.)*

---

## Part 3 — Query Quality

### 3.1 Indexing strategy

16 MongoDB indexes, created by code at startup (`config/MongoIndexConfig.java`)
so they are declared in source, never made by hand. Screenshot of the live
registry: `shot-13-index-registry.png`.

| # | Collection | Index | Kind | Serves |
|---|---|---|---|---|
| 1 | transactions | `{ txnId: 1 }` | unique | safe repeat writes |
| 2 | transactions | `{ cardId: 1, ts: -1 }` | compound | a card's history, newest first |
| 3 | transactions | `{ ts: -1 }` | single | recent transactions |
| 4 | transactions | `{ "merchant.category": 1, flagged: 1 }` | compound | fraud rate by category |
| 5 | transactions | `{ ingestedAt: 1 }` | TTL, 24 h | automatic deletion |
| 6 | transactions | `{ loc: "2dsphere" }` | geospatial | geographic queries |
| 7 | alerts | `{ alertId: 1 }` | unique | look up one alert |
| 8 | alerts | `{ severity: 1, ts: -1 }` | compound | feed ordering |
| 9 | alerts | `{ cardId: 1, ts: -1 }` | compound | all alerts for a card |
| **10** | alerts | **`{ status: 1, severity: 1, ts: -1 }`** | compound | **the triage queue** |
| 11 | alerts | `{ txnId: 1 }` | single | join key to transactions |
| 12 | alerts | `{ "rules.type": 1, ts: -1 }` | multikey | per-rule statistics |
| 13 | alerts_archive | `{ dismissedAt: 1 }` | TTL, 7 d | automatic deletion |
| 14 | blocked_cards | `{ cardId: 1 }` | unique | block / unblock |
| 15 | ring_snapshots | `{ discoveredAt: -1 }` | single | ring history |
| 16 | alerts_archive | `{ originalId: -1 }` | single | restoring the alert-id counter |

Index kinds used: unique, compound, single-field, multikey, TTL, geospatial.

**Index #10 and the ESR rule.** Figure: `fig-05-index-esr.png`.
ESR = Equality, Sort, Range: put the fields tested for equality first, then the
sort field, then any range field. The triage queue filters by an exact status
and an exact severity and sorts by time. With `status, severity` first, MongoDB
seeks straight to the matching block of the index, and inside that block the
entries are already newest first. If time led the index, the equality tests
would be evaluated as a filter over the whole time range.

### 3.2 Index evidence, measured

**Live in the dashboard.** The Triage view runs `explain("executionStats")` for
whatever filter is selected and shows the result. Same 15 rows, three plans,
measured on 2,002 alerts:

| Filter | Winning plan | Work done | To return |
|---|---|---|---|
| none | `SORT ← COLLSCAN` | 2,002 documents examined, sorted in memory | 15 |
| status = NEW | `FETCH ← SORT ← IXSCAN(status_1_severity_1_ts_-1)` | 801 index keys, sorted in memory | 15 |
| status = NEW, severity = HIGH | `LIMIT ← FETCH ← IXSCAN(status_1_severity_1_ts_-1)` | 15 keys, 15 documents, no sort | 15 |

Screenshots: `shot-04-triage-index-scan.png` (IXSCAN) and
`shot-05-triage-collection-scan.png` (COLLSCAN).

**Before and after, six probes.** `scripts/explain-evidence.mjs` drops each
target index, captures the plan, recreates the identical index, and captures
the plan again. Run on 13 October 2026; full output in
`docs/evidence/explain-report.md` with the raw plans as JSON beside it.

| Probe | Query | Without the index | With the index | Improvement |
|---|---|---|---|---|
| P1 | Triage queue: `{status: NEW, severity: HIGH}` sorted by `ts` | `IXSCAN(severity_1_ts_-1)` fallback, 203 docs examined | `IXSCAN(status_1_severity_1_ts_-1)`, 86 docs examined for 86 returned | 2× fewer documents; examined = returned |
| P2 | Card history: `{cardId}` sorted by `ts`, limit 10 | `IXSCAN(ts_-1)`, 40,989 docs, 62 ms | `IXSCAN(cardId_1_ts_-1)`, 10 docs, 0 ms | 4,099× fewer documents |
| P3 | Category + flagged equality | `COLLSCAN`, 159,424 docs, 98 ms | `IXSCAN(merchant.category_1_flagged_1)`, 808 docs, 5 ms | 197× fewer documents |
| P4 | Prior transactions for an alert (the `$lookup` sub-pipeline shape) | `IXSCAN(ts_-1)`, 41,242 docs, 67 ms | `IXSCAN(cardId_1_ts_-1)`, 10 docs, 1 ms | 4,124× fewer documents |
| P5 | Alert feed: `{severity: HIGH}` sorted by `ts` | `SORT ← COLLSCAN`, 2,057 docs | `IXSCAN(severity_1_ts_-1)`, 203 docs | 10× fewer documents, no in-memory sort |
| N1 | Negative control: regex over note text | `COLLSCAN`, 2,057 docs | `COLLSCAN`, 2,057 docs | none: no index helps a substring search |
| P6 | Neo4j: find the starting card of a ring | `NodeByLabelScan`, 8,013 db hits | `NodeUniqueIndexSeek`, 2 db hits | 4,007× fewer db hits |

The negative control is included on purpose: the report shows where indexing
does not help, not only where it does.

**Redis has no separate index structure; the data type is the index.** A sorted
set keeps members ordered by score, so `ZCARD` is O(1) and trimming by time is
O(log N + M). A list would need a full scan to count entries inside a time
bound and cannot be trimmed by score at all.

### 3.3 Aggregation pipelines

Five pipelines, each shown in the dashboard. Screenshot: `shot-11-analytics.png`.

| | Shown as | Collection | Stages | What it demonstrates |
|---|---|---|---|---|
| A | Fraud rate by merchant category | transactions | `$match → $group → $match → $addFields → $sort → $limit → $project` | Grouping, conditional sums with `$cond`, a filter on a computed group size |
| B | Alerts by severity over time | alerts | `$match → $group` (with `$dateTrunc`) `→ $group → $sort → $project` (with `$mergeObjects`, `$arrayToObject`) | Time bucketing; empty severities filled with zero |
| C | Watchlist: top cards by alert count | alerts | `$match → $group` (with `$addToSet`) `→ $addFields` (with `$reduce`, `$setUnion`) `→ $sort → $limit → $project` | Flattening an array of arrays into one distinct set |
| D | The six KPI tiles, detector activity, score bands | alerts | `$match → $facet { $count; $group; $unwind + $group; $bucket; … } → $project` | Seven statistics in one round trip |
| E | The alert detail drawer | alerts | `$match → $lookup → $unwind → $lookup` (correlated, with `let` and `$expr`) `→ $lookup → $project` | Joining an alert to its transaction, its 10 prior transactions, and its block status |

Pipeline A, as written:

```js
db.transactions.aggregate([
  { $match: { ts: { $gte: since } } },
  { $group: { _id: "$merchant.category",
              total:   { $sum: 1 },
              flagged: { $sum: { $cond: ["$flagged", 1, 0] } },
              volume:  { $sum: "$amount" } } },
  { $match: { total: { $gte: 20 } } },
  { $addFields: { fraudRate: { $round: [{ $divide: ["$flagged", "$total"] }, 4] },
                  avgTicket: { $round: [{ $divide: ["$volume", "$total"] }, 2] } } },
  { $sort: { fraudRate: -1 } },
  { $limit: 12 }
])
```

Pipeline E's correlated join (the 10 transactions before the alert, on the same card):

```js
{ $lookup: {
    from: "transactions",
    let: { card: "$cardId", at: "$ts" },
    pipeline: [
      { $match: { $expr: { $and: [ { $eq: ["$cardId", "$$card"] },
                                   { $lt: ["$ts", "$$at"] } ] } } },
      { $sort: { ts: -1 } },
      { $limit: 10 }
    ],
    as: "priorTxns" } }
```

Design points worth stating:

- Pipeline D replaces seven separate queries with one `$facet`, polled every
  3 seconds.
- Pipeline A reads `flagged` straight off the transaction because that field is
  denormalised (Part 2.2); no join to `alerts` is needed.
- Pipeline E's inner pipeline is served by index #2 (`cardId, ts`), which is
  what probe P4 measures.

### 3.4 The graph query

`RING_FOR_CARD`, the centrepiece. Screenshot of its result:
`shot-10-fraud-ring.png` (6 cards, 1 shared device, 2 shared IPs, one card
already blocked).

```cypher
MATCH (seed:Card {cardId: $cardId})
CALL {
  WITH seed
  MATCH (seed)-[:USED_DEVICE|FROM_IP*1..6]-(m:Card)
  WHERE m <> seed
  RETURN collect(DISTINCT m) AS others
}
WITH [seed] + others AS cards
UNWIND cards AS c
MATCH (c)-[r:USED_DEVICE|FROM_IP]->(e)
WITH cards, c, r, e
WHERE size([ (x:Card)-[:USED_DEVICE|FROM_IP]->(e) WHERE x IN cards | x ]) >= 2
RETURN [x IN cards | { id: x.cardId, blocked: coalesce(x.blocked, false) }] AS cardNodes,
       collect(DISTINCT { id: coalesce(e.deviceId, e.ip), type: head(labels(e)) }) AS entityNodes,
       collect(DISTINCT { from: c.cardId, to: coalesce(e.deviceId, e.ip),
                          rel: type(r), weight: r.count }) AS edges
```

- **`*1..6` is bounded.** An unbounded variable-length match over a
  well-connected payment graph tends towards scanning all of it, and cards six
  hops apart are barely related.
- **`WHERE m <> seed`** stops the seed card matching itself through a cycle.
- **`size([...]) >= 2`** keeps only entities shared by two or more ring
  members, so the result shows shared infrastructure, not every device each
  card ever used.
- **The seed lookup is an index seek** (probe P6: 2 db hits against 8,013).

A second query, `ALL_RINGS`, sweeps the whole graph for any device or IP used
by three or more cards and ranks them.

In SQL the same question is a recursive self-join whose depth is not known in
advance.

---

## Part 4 — Prototype / Demo

### 4.1 What the prototype is

A working, running system, started with one command (`.\run`) on a 7.7 GB
laptop without Docker. The dashboard has five views.

| View | Shows | Demonstrates | Screenshot |
|---|---|---|---|
| Live monitor | KPI tiles, live settlement tape, alert feed, four fraud patterns to inject | Redis Streams, the four detectors, the three WebSocket channels | `shot-01-live-monitor.png` |
| Triage | Filterable, paged queue with the live query plan; case drawer; raise, dismiss, bulk dismiss; blocked cards | MongoDB CRUD, index #10, the `$lookup` pipeline, the cross-store block | `shot-04`, `shot-03`, `shot-06`, `shot-07`, `shot-08` |
| Fraud rings | Interactive graph, the Cypher behind it, ring history, most-shared entities | The Neo4j traversal and the Redis → Neo4j handoff | `shot-10-fraud-ring.png` |
| Analytics | Four charts and a watchlist, each labelled with its pipeline stages, each with a table view | Aggregation pipelines A to D | `shot-11-analytics.png` |
| Data stores | A flow strip with live counts, one card per database, the index registry | What each store holds right now | `shot-12-data-stores.png`, `shot-13-index-registry.png` |

Live channels (STOMP over WebSocket): `/topic/txn` (sampled to about 8 rows a
second; flagged and declined rows always sent), `/topic/alerts` (every alert,
full document), `/topic/rings` (each ring as it is resolved).

### 4.2 Demonstration flow

| Step | Action | What appears | Proves |
|---|---|---|---|
| 1 | Open Live monitor | Traffic at about 150 a second on the tape | Ingestion through a Redis Stream |
| 2 | Inject **Velocity burst** | Medium alerts from the fifth transaction | Sliding window read with `ZCARD` |
| 3 | Inject **Unusual amount** | A Low alert with mean, deviation and threshold | A rule that compares a card to its own history |
| 4 | Inject **Impossible travel** | A High alert: Chennai to Delhi, 1,756 km in 2 s | `GEODIST`; evidence shaped differently per rule |
| 5 | Inject **Fraud ring** | Fan-out alerts from the third card, then "Fraud ring discovered" | The Redis → Neo4j handoff |
| 6 | Open Fraud rings | Six cards around one device and two IPs | One bounded traversal |
| 7 | Run the query in Neo4j Browser | The same graph, outside the dashboard | The graph is real |
| 8 | Triage: filter New + High | `IXSCAN` on index #10, 15 keys for 15 documents | Indexing, live |
| 9 | Raise a case, change status, add a note, dismiss | Each change visible at once | Create, Update, Delete |
| 10 | Block a card, return to Live monitor | That card's payments struck through, Declined | A MongoDB write changing the live stream through Redis |

Screenshot for steps 2–5: `shot-02-fraud-injected.png`.
Screenshot for step 10: `shot-09-block-declined.png`.

### 4.3 Measured results

| Measure | Result |
|---|---|
| Sustained throughput | 150 transactions a second (target 150) |
| Transactions lost by the write buffers | 0 dropped by the MongoDB bulk writer, 0 by the graph projector |
| Normal traffic that raises an alert | 57 of 122,609 live transactions (0.05%), including the deliberately injected ones |
| Memory for the whole stack | Under 1 GB (API about 220–340 MB, Neo4j about 215–250 MB, MongoDB about 150–165 MB, Redis about 50 MB, UI about 20 MB) |
| Start from nothing | `.\run` brings up all five processes on freshly loaded data in about 108 s |
| Ring query time | From 9 ms warm to about 400 ms just after start, on this laptop |
| End-to-end smoke test | 7 of 7 checks pass: health, create, update, delete, aggregation, live explain, ring |
| Browser verification | All five views exercised in headless Edge with no JavaScript errors |

Demo data loaded by `.\run` every time: 50,040 transactions, 2,002 alerts, and
one isolated six-card ring (`C-9001` to `C-9006` sharing device `D-SEED-01` and
two IPs), with `C-9004` already blocked.

---

## Part 5 — Documentation & Progress

### 5.1 Documentation set

| Document | Holds |
|---|---|
| `README.md` | What the project is, requirements, how to run it, the five views, the API, the rules, troubleshooting |
| `CLAUDE.md` | The implementation reference: pinned versions, the frozen data models for all three stores, the 16-index registry, the ten-step consumer order, and a decision log |
| `docs/NoSQL_Project.md` | The original design specification |
| `docs/PLAN.md` | The implementation plan: resolved inconsistencies in the spec, the triage workflow, the five pipelines, the index strategy, the build order |
| `docs/evidence/` | `explain-report.md` plus ten raw before / after query plans as JSON |
| `docs/Teacher_demo.md` | Presenter's guide: every component explained, the demo script, likely questions with answers |
| `docs/presentation/` | This file, six diagrams, thirteen screenshots |

**The decision log** has 38 dated entries (D-01 to D-38). Each records a
decision and the reason for it. Many begin with "caught live": a defect found by
running the system, with the measurement that exposed it.

Source code is commented with the reason for each non-obvious choice and a
reference to the relevant section of the reference document.

Size: 51 Java source files (about 4,200 lines) and 21 dashboard source files
(about 2,400 lines).

### 5.2 Progress: how it was built

The project was built as vertical slices: each one ends in something that runs
and can be demonstrated. The git history has one commit per slice (19 commits,
S0 to S17, plus one theme change).

| Phase | Slices | Delivered |
|---|---|---|
| A. Foundation | S0–S3 | Frozen reference document; the three databases and health check; the generator at 150 a second; the consumer group with idempotency and acknowledge-last |
| B. The graded core | S4–S10 | MongoDB write path with validators and indexes; four detectors and alerts; full CRUD triage API; aggregation pipelines A–E; `explain()` evidence; a first dashboard for the graded path; the seed script |
| C. The centrepiece | S11–S14 | Neo4j constraints and batched projector; the two ring queries with snapshots; the ring graph; the three live WebSocket channels |
| D. Polish | S15–S17 | Motion, secondary panels, empty / loading / error states |
| E. Hardening and redesign | 11–13 Oct 2026 | Move off Docker to a native stack; light five-view dashboard; seven read endpoints; six defects found and fixed by testing in a real browser |

Phase B was ordered deliberately so that CRUD, indexing and aggregation were
all complete and demonstrable before any graph or interface work began.

### 5.3 Defects found by running it, and fixed

| Found | Cause | Fix | Result |
|---|---|---|---|
| About 15% of transactions failed | A new Redis connection per transaction exhausted the operating system's ports (101,981 connections in 15 minutes) | Connection pool | 1 new connection in 30 s, no errors |
| About 7 false alerts a second | Amounts were drawn from the merchant's category, so one card mixed ₹400 and ₹15,000 purchases; 4.9% of normal traffic tripped the amount rule | A stable spending profile per card | 0.05% |
| 73,934 warning lines during one data reset | The stream reader retried a missing consumer group with no delay | Recreate the group at once; back off on other errors | 1 line |
| A second, unrelated travel alert after each travel injection | The card rejoined normal traffic after 20 s, inside the 60 s comparison window | Hold it out for the full window | One alert per injection |
| Blocked cards rarely appeared as declined on the live tape | Declined rows went through the same 8-a-second sampler as normal rows | Declined rows bypass the sampler | Every declined row shown |
| Saved ring snapshots missed the injected device | The ring query ran before the triggering edge had been written to Neo4j | Run it one second later | Snapshots show the device with 3, 4, 5, 6 cards |

### 5.4 Design decisions worth quoting from the log

| # | Decision | Reason |
|---|---|---|
| D-04 | Devices capped at 2 cards each; fan-out window 600 s | With the original numbers, mean fan-out was 2.5 against a limit of 3: normal traffic would have alerted continuously |
| D-09 | Dismissal is archive-then-delete | A real delete with a visible count drop, and an audit copy |
| D-10 | MongoDB as a single-node replica set | Enables a real multi-document transaction for the block-card write |
| D-11 | `flagged` and `score` denormalised onto transactions | Avoids a join on every statistics refresh |
| D-12 | Redis `noeviction`, every temporary key with a TTL | `allkeys-lru` could evict the blocklist or the pending list |
| D-13 | Alerts written synchronously, transactions buffered | A 150 : 1 volume ratio; alerts must be readable when announced |
| D-14 | Transactions kept 24 hours, alerts indefinitely | Hot / cold split; alerts carry their own evidence |
| D-20 | Travel rule reads the two latest points from the sorted set and calls `GEODIST` | The originally specified "last location" key could not work with the fixed step order |
| D-34 | Docker removed; native stack; connection pool | Docker's overhead did not fit a 7.7 GB laptop; running natively exposed the connection defect |

---

## Part 6 — Limitations and next steps

State these plainly. Do not hide them.

**Limitations**

- Traffic is synthetic. Nothing is tested against real card data.
- No authentication. The analyst identity is a dropdown.
- Every database is a single node. Clustering and sharding are designed for
  (hashed `cardId` as the shard key) but not implemented.
- No automated test suite. Verification is a smoke script and manual testing.
- One gap in the delivery guarantee: the idempotency key is set before the
  work, so a transaction that fails mid-processing is skipped on redelivery
  rather than retried. For that case the system is at-most-once.
- The `Merchant` node and `PAID` relationship are in the Neo4j schema but are
  not written.
- A ring injected into live traffic can come back larger than the six injected
  cards, because every normal device and IP is legitimately shared by two cards
  and the traversal follows them. The seeded ring is isolated and always shows
  exactly six.
- Redis on Windows is a community build; Redis publishes no official one.

**Next steps**

- Clear the idempotency key on failure to close the redelivery gap.
- Make the amount rule compare within a merchant category.
- Run several consumers in the consumer group.
- Add automated tests and real authentication.

---

## Part 7 — Image manifest

19 PNG files accompany this document. Use them by exact filename. Diagrams are
3200×1800 (16:9). Screenshots are 2400×1350 (16:9) taken from the running
system. Do not redraw, recolour, tilt or add effects to any of them.

Crop boxes are given as fractions of the image: `left, top, right, bottom`,
where `0,0` is the top-left corner and `1,1` the bottom-right.

### Diagrams

| File | Shows | Use on |
|---|---|---|
| `fig-01-architecture.png` | All components, the three stores and the commands that connect them | System Design: architecture |
| `fig-02-pipeline.png` | The ten consumer steps, coloured by store | System Design: life of a transaction |
| `fig-03-data-model.png` | The data model of each store side by side | Database Implementation: data model |
| `fig-04-lifecycle-block.png` | Left: alert status lifecycle. Right: the five-step block-card flow across three stores | Database Implementation: lifecycle and cross-store write |
| `fig-05-index-esr.png` | Left: how index #10 is ordered and why ESR works. Right: three measured plans for the same 15 rows | Query Quality: indexing |
| `fig-06-ring-handoff.png` | Redis notices → Neo4j resolves → MongoDB remembers → analyst sees | System Design: the handoff |

Colour convention in every diagram: Redis red, MongoDB green, Neo4j blue,
application grey. Keep that convention anywhere else a store is colour-coded.

### Screenshots

| File | Shows | Point the audience at | Suggested crop |
|---|---|---|---|
| `shot-01-live-monitor.png` | Live monitor at rest: six KPI tiles, the settlement tape, four fraud patterns, the alert feed | "150/s" throughput tile; the tape; the four Inject buttons | none (full frame) |
| `shot-02-fraud-injected.png` | Seconds after injecting all four patterns: flagged rows on the tape, card ids returned under each pattern, Medium alerts in the feed, the "Fraud ring discovered" notice | The flagged rows; the feed; the ring notice bottom-left | none |
| `shot-03-alert-evidence.png` | An alert opened from the queue: two rules fired with differently shaped evidence, one shown as fields and one as its raw JSON document, then the joined transaction context | The two evidence cards have different fields | drawer only: `0.708, 0, 1, 1` |
| `shot-04-triage-index-scan.png` | Triage queue filtered to New + High, with the query plan line: `IXSCAN status_1_severity_1_ts_-1 · 15 keys and 15 documents examined for 15 returned` | The query plan line | plan line: `0.135, 0.185, 0.81, 0.235` |
| `shot-05-triage-collection-scan.png` | The same queue with no filter: `COLLSCAN · 0 keys and 2,039 documents examined for 15 returned`, with the two warnings | The query plan line | plan line: `0.135, 0.185, 0.81, 0.235` |
| `shot-06-crud-create.png` | The Raise a case dialog filled in: card `C-9002`, severity High, a reason | The dialog | dialog: `0.385, 0.30, 0.615, 0.70` |
| `shot-07-crud-update.png` | An alert after three updates: status pill "Investigating", a note with Edit / Delete, and the audit trail showing "New to Investigating" | The status pill; the note; the audit trail | drawer only: `0.708, 0, 1, 1` |
| `shot-08-crud-delete.png` | The Dismiss confirmation with a reason typed: "The alert is copied to alerts_archive and then deleted from alerts." | The dialog text | dialog: `0.385, 0.36, 0.615, 0.64` |
| `shot-09-block-declined.png` | Live monitor, tape set to "Flagged only": payments on blocked cards `C-0366` and `C-0500` struck through and marked Declined; "Blocked cards 3" | The struck-through rows | tape: `0.129, 0.20, 0.628, 0.74` |
| `shot-10-fraud-ring.png` | Fraud rings view: the seeded ring `C-9001`, six cards around device `D-SEED-01` and two IPs, card `C-9004` in red (blocked); ring history and most-shared entities on the right | The device at the centre; the red blocked card; "6 cards, 3 shared" | graph panel: `0.129, 0.09, 0.813, 0.93` |
| `shot-11-analytics.png` | Four charts (alerts by severity, fraud rate by category, detector activity, score bands) and the top of the watchlist, each labelled with its pipeline stages | The stage line under each chart title | none |
| `shot-12-data-stores.png` | The flow strip with live counts; one card each for Redis, MongoDB, Neo4j; the top of the index registry | The three store cards | top half: `0.129, 0.08, 0.98, 0.64` |
| `shot-13-index-registry.png` | The complete live index registry: all 16 declared indexes with keys, kind and purpose; index #10 highlighted | Row 10; the Unique and TTL tags | table: `0.129, 0.12, 0.98, 0.965` |

Numbers visible in screenshots differ slightly from one to the next (for
example "Awaiting triage") because the system was live while they were taken.
That is expected; do not "correct" them.

---

## Part 8 — Slide-by-slide storyboard

24 slides plus 2 appendix slides. Each slide lists the criterion it serves, a
title written as a claim, the content, the visual, and what the presenter says.
Titles and body text may be tightened, but every fact must come from Parts 0–7.

### 1 · Title
- **Criterion:** none
- **Title:** SentinelStream
- **Subtitle:** Real-time card fraud detection and fraud-ring discovery using polyglot NoSQL persistence
- **Footer line:** NoSQL Databases — Course Project · Yash Sehrawat · 23BCE0161 · VIT Vellore
- **Visual:** none, or `shot-01-live-monitor.png` as a restrained right-hand image
- **Notes:** "SentinelStream detects card fraud in real time across three NoSQL databases, each doing the one job its data model is built for."

### 2 · What this deck covers
- **Criterion:** none (orientation)
- **Title:** Five things to evaluate, and where each is shown
- **Content:** a five-row table: criterion → what is shown → slide numbers. System Design (3–8) · Database Implementation (9–13) · Query Quality (14–18) · Prototype / Demo (19–21) · Documentation & Progress (22–23).
- **Notes:** "The deck follows the five evaluation criteria in order. Each slide is tagged with the criterion it serves."

### 3 · The problem
- **Criterion:** System Design
- **Title:** Fraud detection has two requirements that no single data model serves
- **Content:** two short statements side by side. Left: "Decide within milliseconds: no scanning of history." Right: "Find organised fraud: many cards, one device, no single suspicious transaction." Below: the five numbered requirements from 1.1, tightened.
- **Notes:** "The first requirement wants constant-time lookups over recent activity. The second wants multi-hop connectivity analysis. Those are different data models."

### 4 · Why three databases
- **Criterion:** System Design
- **Title:** Each store is chosen for an access pattern that is native to it
- **Content:** the table from 1.2 with three columns (Requirement, Store, Why), store names in their colours. One line beneath: "At this scale one PostgreSQL instance could do all of it. The polyglot design earns its complexity under volume and latency pressure."
- **Notes:** "I state the counter-argument myself. The point of the course is matching data models to access patterns, and this design does that deliberately."

### 5 · Architecture
- **Criterion:** System Design
- **Title:** One stream in, three stores, one dashboard out
- **Visual:** `fig-01-architecture.png`, as large as the slide allows
- **Notes:** "The generator writes to a Redis Stream. The consumer reads it, updates sliding windows in Redis, runs the detectors, and writes to MongoDB and Neo4j through buffers. The API serves the dashboard over REST and a WebSocket. The label on each arrow is the actual command."

### 6 · The life of one transaction
- **Criterion:** System Design
- **Title:** Ten steps in a fixed order, and the acknowledgement always comes last
- **Visual:** `fig-02-pipeline.png`, as large as the slide allows
- **Notes:** "Nothing blocking sits on the hot path. Transactions and graph edges are buffered; the alert is written at once because it must be readable the moment it is announced. XACK is last, so a crash anywhere before it means redelivery, not loss."

### 7 · The detection rules
- **Criterion:** System Design
- **Title:** Four deterministic rules, each answered by one Redis read
- **Content:** the rule table from 1.5 (Rule, Fires when, Redis read, Points). Beneath: "Score = sum of points, capped at 100. Low 1–39 · Medium 40–69 · High 70–100." A small second table or line: the four structural guarantees that keep normal traffic quiet.
- **Notes:** "No machine learning. If you ask why a transaction was flagged I can give the exact numbers, because every alert stores them. And the traffic generator is built so normal traffic cannot trip a rule by accident."

### 8 · The handoff
- **Criterion:** System Design
- **Title:** Redis notices early; Neo4j resolves the whole group
- **Visual:** `fig-06-ring-handoff.png`, as large as the slide allows
- **Notes:** "No single one of these six transactions is suspicious. Redis sees the third card on one device and raises fan-out. That hands off to Neo4j, which returns the whole ring in one traversal. MongoDB stores it and the dashboard is told. This is the moment the three-store design exists for."

### 9 · Data model
- **Criterion:** Database Implementation
- **Title:** Three data models, each shaped by how its data is read
- **Visual:** `fig-03-data-model.png`, as large as the slide allows
- **Notes:** "Redis keys are named after the question they answer and every temporary key expires. MongoDB embeds what is always read together. Neo4j stores entities and relationships; a transaction is an event, so it becomes a count on a relationship, not a node."

### 10 · Why alerts are documents
- **Criterion:** Database Implementation
- **Title:** Each rule proves something different, so its evidence has a different shape
- **Content (left):** the four evidence shapes from 2.2 as one monospace block.
- **Visual (right):** `shot-03-alert-evidence.png`, cropped to the drawer.
- **Notes:** "A velocity rule records a count and a window. A travel rule records two cities, a distance and a speed. In a relational table that is a wide table full of nulls or a key-value side table and a join. Here it is stored as it is, and the validator explicitly allows it."

### 11 · Schema decisions for the document model
- **Criterion:** Database Implementation
- **Title:** The schema was designed for MongoDB, not translated from tables
- **Content:** the decisions table from 2.2 (Decision, What was done, Why), limited to six rows: embed, polymorphic sub-document, denormalise, bounded arrays, hot / cold split with TTL, reference where lifetimes differ. One line: "Five collections, each with a JSON Schema validator."
- **Notes:** "Each of these is a choice a relational design would not make. Embedding, denormalising for reads, letting TTL indexes delete old data: these are the document model used on purpose."

### 12 · CRUD
- **Criterion:** Database Implementation
- **Title:** All four operations are real MongoDB calls, each reachable from the dashboard
- **Content:** a 2 × 2 grid. Each cell: the operation name, the MongoDB call in monospace, and a cropped screenshot. Create: `insertOne`, `shot-06` (dialog crop). Read: `find` + `$lookup` aggregation, `shot-04` (full or queue area). Update: `findOneAndUpdate` with `$set` / `$push` / `$pull`, `shot-07` (drawer crop). Delete: archive, then `deleteOne` / `deleteMany`, `shot-08` (dialog crop).
- **Notes:** "Create raises a case by hand. Read is the queue and the detail view. Update covers status, assignment and notes, and every status change is appended to an audit trail. Delete copies the alert to an archive, then really deletes it."

### 13 · Lifecycle and the cross-store write
- **Criterion:** Database Implementation
- **Title:** One analyst action updates three stores, in a defined order
- **Visual:** `fig-04-lifecycle-block.png` as the main visual. If space allows, `shot-09-block-declined.png` cropped to the tape as a small inset captioned "Result on the live tape".
- **Notes:** "Status changes are enforced on the server; an illegal move is rejected. Blocking a card is a MongoDB transaction first, then the Redis blocklist, then the graph. The card's very next payment is declined at step one of the consumer. A write to MongoDB has changed the live stream, through Redis."

### 14 · Indexing strategy
- **Criterion:** Query Quality
- **Title:** Sixteen indexes, declared in code, each serving a named query
- **Visual:** `shot-13-index-registry.png` cropped to the table, with row 10 called out.
- **Content (side or below):** "Kinds used: unique, compound, multikey, TTL, geospatial." and "Read live from the database, not from documentation."
- **Notes:** "Every index is created by code at startup, and every MongoDB query on a request path is backed by one. This table is read from the running database. Index ten is the one I will defend."

### 15 · Index #10 and the ESR rule
- **Criterion:** Query Quality
- **Title:** Equality first, then sort: work done equals rows returned
- **Visual:** `fig-05-index-esr.png`, as large as the slide allows
- **Notes:** "The triage queue filters on exact status and exact severity and sorts by time. With those two fields leading the index, MongoDB seeks to the matching block and reads it already in order. Fifteen keys for fifteen documents. With no filter it scans all two thousand and sorts in memory."

### 16 · Index evidence
- **Criterion:** Query Quality
- **Title:** Measured, not asserted: before and after for six queries
- **Content:** the probe table from 3.2 with columns Probe, Query, Without, With, Improvement. Keep the negative control row N1 and label it as such. Small inset pair below or beside: the plan-line crops of `shot-04` (IXSCAN) and `shot-05` (COLLSCAN), captioned "The same evidence, live in the dashboard".
- **Notes:** "The evidence script drops each index, captures the plan, recreates it and captures it again. Card history goes from forty-one thousand documents to ten. I include a negative control, a regex search that no index helps, so the report shows the limit of indexing too. The last row is the Neo4j equivalent."

### 17 · Aggregation pipelines
- **Criterion:** Query Quality
- **Title:** Five pipelines, each driving something the analyst sees
- **Content (left):** the pipeline table from 3.3 reduced to: letter, what it drives, the key operators.
- **Visual (right):** `shot-11-analytics.png`.
- **Notes:** "Each chart is labelled with its own stages. Pipeline D is one facet that returns seven statistics in a single round trip. Pipeline A needs no join because the flag is denormalised onto the transaction."

### 18 · Two pipelines in detail, and the graph query
- **Criterion:** Query Quality
- **Title:** A correlated `$lookup` and a bounded traversal
- **Content (left):** the pipeline E `$lookup` snippet from 3.3, with one line: "Served by index #2; probe P4 measured 41,242 → 10 documents."
- **Content (right):** the first eight lines of `RING_FOR_CARD` from 3.4 (through the `CALL { }` block), with three short annotations: "`*1..6` bounded", "`m <> seed` no self-match through cycles", "seed found by index seek: 2 db hits against 8,013".
- **Notes:** "The lookup fetches the ten payments before the alert on the same card, using a correlated sub-pipeline. The Cypher query follows device and IP links up to six hops. In SQL this would be a recursive self-join of unknown depth."

### 19 · The prototype
- **Criterion:** Prototype / Demo
- **Title:** A running system: 150 transactions a second on a 7.7 GB laptop
- **Visual:** `shot-01-live-monitor.png`, full frame, as large as the slide allows.
- **Content (one line):** "Started with one command. Five views: Live monitor, Triage, Fraud rings, Analytics, Data stores."
- **Notes:** "This is the live monitor. The tape on the left is real traffic through the stream, sampled so it can be read. On the right are four fraud patterns I can inject on demand."

### 20 · Demonstration
- **Criterion:** Prototype / Demo
- **Title:** Four patterns injected, four rules fire, one ring is resolved
- **Visual (left, larger):** `shot-02-fraud-injected.png`.
- **Visual (right):** `shot-10-fraud-ring.png` cropped to the graph panel.
- **Content:** a compact numbered list of the ten demo steps from 4.2 is optional; if it does not fit cleanly, put it in the notes only.
- **Notes:** the ten steps from 4.2, one sentence each.

### 21 · Measured results
- **Criterion:** Prototype / Demo
- **Title:** What was measured on the running system
- **Content:** three or four large figures with labels, chosen from 4.3: "150 / s sustained", "0 dropped by either write buffer", "0.05% of normal traffic raises an alert", "under 1 GB for the whole stack". Below: "7 of 7 smoke checks pass · all five views verified in a browser with no JavaScript errors".
- **Visual:** `shot-12-data-stores.png` cropped to the top half, as supporting evidence.
- **Notes:** "These are measurements, not targets. The data stores view shows the same counters live: stream length, pending entries, buffer flushes and drops, node and relationship counts."

### 22 · Documentation
- **Criterion:** Documentation & Progress
- **Title:** Every decision is written down with its reason
- **Content:** the document table from 5.1 (Document, Holds). Beneath, as a highlighted figure: "38 dated decisions in the log". Then three or four rows from 5.4 as examples.
- **Notes:** "The reference document freezes the data models and the consumer order. The decision log records what was decided and why, including the mistakes: many entries start with a defect found by running the system."

### 23 · Progress
- **Criterion:** Documentation & Progress
- **Title:** Built in vertical slices, with the graded core finished first
- **Content:** a horizontal five-phase timeline built from 5.2 (A Foundation · B Graded core · C Centrepiece · D Polish · E Hardening and redesign), each phase with its slice range and two or three delivered items. Beneath: the defect table from 5.3 reduced to three rows (connections, false alerts, ring snapshots) with before → after.
- **Notes:** "Each slice ended in something runnable. Phase B was ordered so CRUD, indexing and aggregation were demonstrable before any graph work. The last phase moved off Docker and, by testing in a real browser, found and fixed six defects."

### 24 · Limitations, next steps, summary
- **Criterion:** all
- **Title:** What it does not do yet, and what it shows
- **Content (left):** four limitations from Part 6: synthetic data, single-node stores, no automated tests, the redelivery gap.
- **Content (right):** three next steps.
- **Bottom line:** "Three data models, each used for the access pattern it is native to: stream and windows in Redis, documents and aggregations in MongoDB, traversal in Neo4j."
- **Notes:** "I would rather state the limits than have them found. Questions."

### Appendix A · Redis key registry
- The full table from 2.1 and the live evidence block.

### Appendix B · Full index registry and REST surface
- The full 16-row table from 3.1 and the REST list from 2.3.
