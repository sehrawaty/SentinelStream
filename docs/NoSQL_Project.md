# SentinelStream

**Real-Time Card Fraud Detection and Fraud-Ring Discovery Using Polyglot NoSQL Persistence**

NoSQL Databases — Course Project
Yash Sehrawat · 23BCE0161 · VIT Vellore

---

## 1. Abstract

Card fraud is detected under two competing constraints. A decision must be returned within the authorization window — a few hundred milliseconds — which rules out any check that requires scanning historical tables. Yet the most damaging fraud is organised: a single compromised device or proxy IP is used to operate many stolen cards, and each individual transaction looks unremarkable in isolation. The first constraint demands O(1) lookups over recent activity; the second demands multi-hop connectivity analysis over an entity network. No single data model serves both well.

SentinelStream implements both against a live synthetic transaction stream of roughly 150 transactions per second. Redis Streams provide ordered, replayable ingestion with consumer-group semantics and at-least-once delivery. Redis sorted sets, sets and geospatial indexes maintain sliding-window state per card, supporting four real-time detectors — transaction velocity, amount anomaly against a rolling mean, geographically impossible travel, and entity fan-out — each evaluated in constant or logarithmic time without touching disk. MongoDB stores transactions, alerts and ring snapshots as documents, accommodating the heterogeneous and evolving rule-evidence payload attached to each alert without schema migration. Neo4j maintains a projected entity graph of cards, devices, IP addresses and merchants, in which fraud rings are recovered by a single variable-length traversal — a query that would require recursive self-joins of indeterminate depth in a relational schema.

The system exposes a live operations dashboard over WebSocket, showing the transaction stream, alerts as they fire, and the ring subgraph rendered at the moment it is discovered. The project's central argument is that the three storage engines are not interchangeable: each is selected because the access pattern it serves is native to its data model and awkward in the others.

**Keywords:** NoSQL, polyglot persistence, Redis Streams, sliding-window analytics, graph traversal, fraud detection, real-time systems

---

## 2. Problem statement

Given a continuous stream of card transactions, the system must:

1. Score every transaction against behavioural rules within the stream's arrival budget, using only in-memory state.
2. Maintain per-card state over a sliding window without unbounded memory growth.
3. Detect coordinated fraud — sets of cards linked through shared devices or network origins — where no single transaction is individually suspicious.
4. Retain full transaction and alert history for investigation, tolerating an alert payload whose shape varies by which rules fired.
5. Surface all of the above to an operator in real time.

## 3. Why three databases

The most common failure of a NoSQL course project is substituting MongoDB for MySQL and changing nothing else. The justification below is the actual substance of this project and should be reproduced in the report.

| Requirement | Engine | Why this model, and why not the others |
|---|---|---|
| Ordered, replayable ingestion with consumer groups and redelivery | **Redis Streams** | An append-only log with per-consumer acknowledgement and pending-entry tracking. A relational queue table needs polling, locking and manual cleanup; a plain pub/sub loses messages on consumer downtime. |
| Sliding-window counters, rolling means, geospatial deltas | **Redis ZSet / Set / GEO** | `ZREMRANGEBYSCORE` trims a time window in O(log N + M) and `ZCARD` reads it in O(1). The equivalent SQL is a `COUNT(*)` with a timestamp predicate on every transaction — an index scan per authorization. `GEODIST` gives the travel-speed check directly. |
| Multi-hop ring discovery over cards ↔ devices ↔ IPs | **Neo4j** | A ring is a connected component of unknown depth. Cypher expresses it as `-[:USED_DEVICE\|FROM_IP*1..6]-`; SQL requires a recursive CTE whose cost grows sharply with depth, and which cannot be indexed for traversal. Relationship traversal in Neo4j is a pointer hop, not a join. |
| Heterogeneous alert evidence, transaction history | **MongoDB** | Each alert carries a variable-length array of rule objects whose fields differ by rule type. In a relational schema this is either a sparse wide table or an EAV join. Documents store it natively and index it with a compound index on `severity` and `ts`. |

State the honest counterargument too, because you will be asked it: **a single PostgreSQL instance with `JSONB`, a `ltree`/recursive CTE and materialised counters could do all of this at low volume.** The polyglot design earns its complexity at scale and under latency budgets, and costs operational overhead in return. Saying this yourself is far stronger than being caught by it.

---

## 4. Architecture

```
┌──────────────────┐
│ Transaction      │  synthetic, ~150 txn/s, configurable
│ Generator        │  injects seeded fraud patterns on demand
└────────┬─────────┘
         │ XADD
         ▼
┌──────────────────┐
│  REDIS           │
│  txn:stream      │  Stream, MAXLEN ~100k
└────────┬─────────┘
         │ XREADGROUP  (group: fraud-detectors)
         ▼
┌─────────────────────────────────────────────────┐
│  Ingestion Consumer                             │
│  1. idempotency guard  SET NX EX                │
│  2. update windows     ZADD / GEOADD / SADD     │
│  3. evaluate rules     4 detectors → score      │
│  4. persist            Mongo transactions       │
│  5. enqueue edges      → Neo4j batch writer     │
│  6. publish alert      PUBLISH alerts:live      │
│  7. XACK                                        │
└──┬───────────────┬──────────────┬───────────────┘
   │               │              │
   ▼               ▼              ▼
┌────────┐  ┌────────────┐  ┌──────────────┐
│MongoDB │  │  Neo4j     │  │ Redis Pub/Sub│
│txns    │  │ entity     │  │ alerts:live  │
│alerts  │  │ graph      │  └──────┬───────┘
│rings   │  │            │         │
└────────┘  └─────┬──────┘         │
                  │ ring query     │
                  ▼                ▼
         ┌────────────────────────────────┐
         │  Spring Boot API + STOMP        │
         │  /api/*   /topic/*              │
         └────────────┬───────────────────┘
                      ▼
         ┌────────────────────────────────┐
         │  React Dashboard                │
         └────────────────────────────────┘
```

**The handoff worth narrating in the demo:** when `ENTITY_FANOUT` fires in Redis — a device now linked to three or more distinct cards — the consumer calls the Neo4j ring query for that card. Redis says *something is odd here*; Neo4j says *here is the whole group*. That single moment is where the two data models earn their keep, and it is what the graph panel animates.

---

## 5. Component specification

**Generator.** Emits transactions across ~500 cards, ~80 merchants, ~200 devices, ~300 IPs, across 12 Indian cities with real coordinates. Baseline traffic is benign. Three injectable patterns, exposed as REST controls:

- `POST /api/control/inject/velocity` — one card, 12 transactions in 20 seconds
- `POST /api/control/inject/travel` — consecutive transactions Chennai → Delhi, 4 minutes apart
- `POST /api/control/inject/ring` — six previously unrelated cards begin transacting from one shared device and two shared IPs

The third is the demo centrepiece.

**Ingestion consumer.** Spring's `StreamMessageListenerContainer` against consumer group `fraud-detectors`. Ordering of side effects is fixed in CLAUDE.md §7 — `XACK` last, always, so that a crash mid-processing results in redelivery rather than loss.

**Rules engine.** Four detectors, weighted, summed to a severity band. Thresholds externalised to `application.yml`. Deliberately rule-based rather than ML: an examiner asking "why was this flagged" must get an exact answer.

**Graph projector.** Bounded queue, flushed every 500ms or 100 edges. `MERGE` with counter increment, never `CREATE`. Never on the hot path.

**API and WebSocket.** REST for history and on-demand queries, STOMP topics for the three live channels.

---

## 6. Data models

Full specification — Redis key registry, Neo4j schema and constraints, ring queries, MongoDB collections and indexes — is in **CLAUDE.md §4**. That file is the single source of truth; do not duplicate it here, reference it. For the written report, reproduce §4 as an appendix with a short paragraph of commentary per store.

---

## 7. Interface design direction

The dashboard is the thing the examiner actually looks at, and "polished" is mostly a function of restraint plus a handful of details that generic dashboards skip. This section is prescriptive — hand it to the agent verbatim.

### 7.1 Position

A fraud desk at a card network, at 2am. The visual world is payment infrastructure, not consumer fintech: authorization codes, BIN ranges, merchant category codes, settlement tape. Dense, technical, calm. It should look like something an analyst stares at for eight hours, not like a landing page.

Explicitly avoid: the near-black background with one acid-green accent, the glassmorphism card stack, the purple gradient hero. Those read as template.

### 7.2 Tokens

```css
--ground:    #0D141B;  /* ink navy, not black — softer under projector light */
--panel:     #141E27;
--panel-2:   #1B2733;
--line:      #22303C;
--text:      #E4EBF0;
--text-mute: #7D93A3;
--signal:    #F2A03D;  /* amber — alerts, the primary accent */
--critical:  #E2574C;  /* vermilion — HIGH severity only, used sparingly */
--calm:      #3FA7A0;  /* teal — normal / healthy state */
--ring:      #8B7FD4;  /* violet — graph edges and ring membership */
```

Amber as the primary accent is doing real work here: it is the ink colour of thermal receipt printers and terminal displays, it reads as *attention* rather than *danger*, and it leaves vermilion free to mean genuine escalation. If everything is red, nothing is.

### 7.3 Typography

- **Display / headings — Space Grotesk.** Slightly irregular letterforms, technical without being sci-fi.
- **Body / UI — IBM Plex Sans.** Chosen deliberately: IBM Plex descends from mainframe and financial-terminal typography, which is literally the world this system lives in. Worth one sentence in the report.
- **Data / IDs / amounts — IBM Plex Mono**, with `font-variant-numeric: tabular-nums`.

Tabular figures are the single highest-value polish detail in this entire project. Without them, every digit in the live ticker changes width as it updates and the whole column shivers. With them it locks solid. Nobody consciously notices it; everybody notices its absence.

Scale: 11 / 13 / 15 / 20 / 32px. Headings at 500 weight, not 700 — heavy weights on a dark ground bloom.

### 7.4 Layout

```
┌────────────────────────────────────────────────────────────┐
│ SENTINELSTREAM      ● live   1,284 txn/s ↑   14 alerts     │  KPI strip
├──────────┬─────────────────────────────────────────────────┤
│          │                                                  │
│ SETTLE-  │   ALERT FEED                                     │
│ MENT     │   ┌────────────────────────────────────────┐    │
│ TAPE     │   │ HIGH  IMPOSSIBLE_TRAVEL  ····9012      │    │
│          │   │ MED   VELOCITY           ····4471      │    │
│ (live    │   └────────────────────────────────────────┘    │
│  txn     │                                                  │
│  stream) ├─────────────────────────┬───────────────────────┤
│          │  RING GRAPH             │  RULE ACTIVITY        │
│          │  (Cytoscape)            │  (Recharts, 60s)      │
│          │                         │                       │
└──────────┴─────────────────────────┴───────────────────────┘
```

Left tape is fixed-width ~320px and scrolls independently. Graph panel expands to fullscreen on click — you will want this during the demo.

### 7.5 Signature element

**The settlement tape.** The live transaction stream renders as a continuous monospaced receipt tape down the left edge — fixed columns, hairline dividers, no card chrome, no rounded corners. Each arriving row prints character-by-character over ~120ms, like a terminal printer, then sits still. Flagged rows get a left border in `--signal` and a single 400ms background fade; they do not pulse forever.

One orchestrated moment, everything else still. That restraint is what separates this from a dashboard with animation on every element.

### 7.6 Motion and states

- New rows: 120ms print-in. Alerts: one 400ms fade, then static.
- Ring detection: the graph traces its edges once, over 600ms, then settles. This is the only animation longer than half a second in the entire application.
- Respect `prefers-reduced-motion` — disable print-in and edge-tracing, keep the colour states.
- Empty states name the next action: "No alerts yet. Inject a fraud ring to see detection live." Not "No data available."
- Loading: skeleton rows in the tape's exact geometry, so nothing shifts when data arrives.
- Errors state what broke and what to do: "Stream disconnected. Reconnecting in 3s." Never a bare toast.

### 7.7 Quality floor

Keyboard focus visible on all controls. Panels collapse to a single column below 900px. No text below 11px. Contrast at least 4.5:1 for body text — check `--text-mute` on `--panel` specifically, it is the one most likely to fail.

---

## 8. Execution plan

Assumes ~2.5 hour working sessions, fragmented around placements. Four weeks with slack; the compressed lane at the end is the fallback.

**Week 1 — Foundations**
- S1: Slice 0. Docker Compose up, versions resolved into CLAUDE.md §2, connectivity test passing.
- S2: Slice 1a. Generator producing to `txn:stream`. Verify with `XLEN` and `XRANGE` in `redis-cli`.
- S3: Slice 1b. Consumer group, idempotency guard, console output. *Milestone: something is alive.*

**Week 2 — Detection and first light**
- S4: Slice 2a. Velocity + amount detectors, scoring, severity bands.
- S5: Slice 2b. Impossible travel + entity fan-out. Injectable patterns wired to REST.
- S6: Slice 3a. STOMP endpoint, React scaffold, tokens from §7 in place.
- S7: Slice 3b. Settlement tape and alert feed, live. *Milestone: demoable to a friend.*

**Week 3 — The graph**
- S8: Slice 4a. Neo4j constraints, batched edge projection, verify in Neo4j Browser.
- S9: Slice 4b. Both ring queries, REST endpoints, tested against the seeded ring.
- S10: Slice 5. Cytoscape panel, ring rendering, edge-trace animation. *Milestone: the centrepiece works.*

**Week 4 — Substance and shine**
- S11: Slice 6. Mongo persistence, history endpoints, KPI aggregations.
- S12: Slice 7a. Empty/loading/error states, reduced-motion, responsive pass.
- S13: Slice 7b. Seed script, README, screenshots, demo rehearsal end to end.
- S14: Report writing and viva prep from §10.

**Compressed lane (2 weeks).** Cut in this order: rule-activity chart, the "all rings" panel, merchant statistics, MongoDB history views (keep the writes, drop the read UI). Never cut: the ring query, the graph panel, the injectable ring pattern. Those three are the project.

---

## 9. Demo script

Five minutes. Rehearse it twice with the projector resolution you will actually present at.

1. **(0:00)** Dashboard already running, benign traffic flowing. "This is live synthetic card traffic, about 150 transactions a second, ingested through Redis Streams." Point at the tape.
2. **(0:45)** Inject velocity. A card lights amber. "Five transactions in sixty seconds — that's a Redis sorted set trimmed by timestamp, O(1) to read the count. No table scan."
3. **(1:30)** Inject impossible travel. "Chennai to Delhi in four minutes — 1,760 km/h implied. That's `GEODIST` between the last two points over the time delta."
4. **(2:15)** Inject the ring. Six cards begin firing. Fan-out triggers. "Individually, none of these transactions is remarkable. But Redis has just noticed one device is now behind three separate cards — and that's the point where it hands off to the graph."
5. **(3:00)** Graph panel expands, edges trace, six cards resolve around one device node. "One Cypher traversal, variable depth up to six hops. In SQL this is a recursive CTE with no bound on depth."
6. **(4:00)** Open Neo4j Browser, run the raw query live. Showing the query outside your own UI is what convinces people the graph is real and not a drawing.
7. **(4:30)** Mongo: the alert document with its variable rule-evidence array. "Different rules produce different evidence shapes — that's why alerts are documents."

Have `redis-cli` and Neo4j Browser open on a second workspace before you start. Have a screen recording of a successful run as insurance.

---

## 10. Viva preparation

Prepare answers to all of these. This is where the marks that separate a working project from a good one actually sit.

**On Redis**
- Why a sorted set rather than a list for the velocity window?
- What happens to your windows if Redis restarts? (AOF is on; but be honest that a cold start loses partial windows and that this is acceptable because windows are short and self-healing.)
- Why consumer groups instead of plain pub/sub?
- What is `XPENDING` and when have you used it?
- Your consumer crashes mid-transaction. What happens to that message, and how do you avoid double-counting?
- What is your eviction policy and why is `allkeys-lru` wrong here?

**On Neo4j**
- Why are transactions not nodes in the graph?
- Write the ring query on the board. Explain `*1..6` — why bounded?
- What does the uniqueness constraint give you besides uniqueness? (An index, and therefore a fast seed lookup for the traversal.)
- Why `MERGE` and not `CREATE`?
- What is the cost difference between a Neo4j traversal and a SQL recursive join?

**On MongoDB**
- What is your shard key if you had to shard this, and why?
- Why compound index `{cardId: 1, ts: -1}` in that order?
- Justify documents over a relational alert table.
- What are change streams and why did you not use them?

**On the system**
- Which database is your bottleneck at 10× traffic, and what breaks first?
- CAP: what do you sacrifice, and where?
- How would you handle a transaction arriving out of order?
- Why not just use PostgreSQL? (Section 3 — answer it before they finish asking.)
- What would you do differently with another month?

---

## 11. Deliverables checklist

- [ ] Source repository, README with one-command setup
- [ ] `docker-compose.yml` with resource limits tuned for a laptop
- [ ] Seed script producing a reproducible demo state
- [ ] Report: abstract, problem, justification (§3 is the core), architecture, data models as appendix, results, screenshots
- [ ] Screenshots: dashboard at rest, alert firing, ring graph expanded, Neo4j Browser query result
- [ ] Screen recording of a successful demo run
- [ ] Presentation deck, 8–10 slides, following §9's order
- [ ] Decision log from CLAUDE.md §8, revised

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Neo4j exhausts laptop RAM | Heap capped in compose; if it dies, lower it rather than raise |
| Graph panel jitters | Cytoscape + `fcose`, layout runs only on node-set change |
| Multi-service integration eats the schedule | Strict one-slice-per-session; slice 6 is the designated cut |
| Agent redesigns the schema mid-project | CLAUDE.md §4 is frozen and re-read every session |
| Demo fails live | Screen recording as backup; rehearse at projector resolution |
| Placement interviews consume a week | Compressed lane in §8 |
