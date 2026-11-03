# SentinelStream — how to explain and demonstrate it

This is your presenter's guide. It explains every part of the project in plain
language, tells you what to click and what to say, and prepares you for the
questions a teacher is likely to ask. Read Parts 1 to 6 once to understand the
system, rehearse Part 8 twice, and keep Part 10 open for the viva.

Lines marked **Say:** are sentences you can use almost word for word.

---

## Part 1 — The project in one minute

**Say:** "SentinelStream detects card fraud in real time. It has to do two things
that pull in opposite directions. First, decide about every transaction within
milliseconds, which means it cannot scan history tables. Second, find organised
fraud, where many stolen cards are run from one device, and no single
transaction looks suspicious on its own. No single database is good at both, so
I use three, each for the one job its data model is built for."

| Database | Its job here | Why this one |
|---|---|---|
| **Redis** | Takes in the transaction stream and keeps short-lived per-card counters | In-memory; reading a time window costs almost nothing |
| **MongoDB** | Stores transactions and alerts permanently; runs the analyst workflow and the statistics | Each alert carries different evidence, which fits a document, not a fixed table |
| **Neo4j** | Stores which card used which device and IP; finds fraud rings | A ring is a "follow the connections" question, which is what a graph database does natively |

Using several databases together, each for what it does best, is called
**polyglot persistence**. That phrase is the title of the project.

**The honest counter-argument, which you should raise yourself:** "At this small
scale a single PostgreSQL server with JSONB and recursive queries could do all
of it. The three-database design earns its complexity under high volume and
tight latency, and it costs more to operate. I chose it because the course is
about matching data models to access patterns."

---

## Part 2 — The pieces and how they connect

```
 Generator ──XADD──▶ Redis Stream "txn:stream"
 (fake card traffic,          │
  ~150 per second)            │ XREADGROUP (consumer group "fraud-detectors")
                              ▼
                     Consumer (Spring Boot)
                     1. is the card blocked?        Redis  SISMEMBER
                     2. seen this one before?       Redis  SET NX
                     3. update sliding windows      Redis  ZADD / GEOADD
                     4. run 4 detectors → score     Redis  ZCARD / GEODIST
                     5. save transaction            MongoDB (buffered)
                     6. save alert, if any          MongoDB (immediately)
                     7. queue graph edges           Neo4j  (buffered)
                     8. ring query, if fan-out      Neo4j  (background thread)
                     9. publish live updates        Redis Pub/Sub → WebSocket
                    10. acknowledge                 Redis  XACK   ← always last
                              │
                              ▼
                 React dashboard  http://localhost:3000
```

There are five programs running:

| Program | Port | What it is |
|---|---|---|
| Redis | 6379 | In-memory database |
| MongoDB | 27017 | Document database, run as a one-node replica set called `rs0` |
| Neo4j | 7687 (and 7474 for its own web console) | Graph database |
| The API | 8080 | The Java / Spring Boot program. It contains the generator, the consumer, the detectors and the REST endpoints |
| The dashboard | 3000 | The React user interface, served by Vite |

**Why MongoDB is a "replica set" with only one node:** multi-document
transactions in MongoDB only work on a replica set. Blocking a card updates two
collections together, so it needs one.

---

## Part 3 — The life of one transaction

This is the heart of the project. If you can explain these ten steps, you can
explain the system. The order is fixed, and the code is in
`api/src/main/java/com/sentinelstream/consumer/TransactionConsumer.java`.

A transaction looks like this: card `C-0417` paid ₹4,821.50 at merchant
"Pothys" in Chennai, from device `D-0142` and IP `49.207.14.88`.

**Step 0. The generator writes it to the stream.** `XADD txn:stream ...`. A
Redis Stream is an append-only log. It keeps the last 100,000 entries, about 11
minutes of traffic.

**Step 1. Blocklist check.** `SISMEMBER blocklist:cards C-0417`. If an analyst
has blocked this card, the transaction is marked `declined`, the detectors are
skipped, and it is still saved.

**Step 2. Idempotency guard.** `SET idem:txn:<id> 1 NX EX 900`. `NX` means "only
if it does not exist". If the key was already there, this message is a repeat
delivery, so it is acknowledged and dropped. This is what stops double counting.

**Step 3. Update the sliding windows.** In one round trip (a *pipeline*) it
removes old entries and adds this transaction to five keys:

| Key | Type | Holds | Used by |
|---|---|---|---|
| `card:C-0417:txns` | Sorted set, score = time | this card's transaction ids, last 60 s | Velocity, Impossible travel |
| `card:C-0417:amts` | Sorted set | this card's recent amounts | Amount anomaly |
| `card:C-0417:geo` | Geo index | where each transaction happened | Impossible travel |
| `device:D-0142:cards` | Sorted set | which cards used this device, last 10 min | Entity fan-out |
| `ip:49.207.14.88:cards` | Sorted set | which cards used this IP, last 10 min | Entity fan-out |

Every one of these keys has an expiry (TTL), so memory can never grow without
limit.

**Step 4. Run the four detectors** (Part 4). They only *read* what step 3 just
wrote. The result is a score from 0 to 100.

**Step 5. Save the transaction to MongoDB, through a buffer.** It is put in an
in-memory queue and written in batches of 200, or every half second. Writing
150 separate inserts a second on the critical path would be slow; one bulk
write is not. It is an *upsert* on `txnId`, so writing the same one twice is
harmless.

**Step 6. Save the alert, if the score is above 0, immediately.** Alerts are
rare and important, and the dashboard must be able to load an alert the moment
it is announced. So this write is not buffered.

**Step 7. Queue the graph edges for Neo4j.** "Card used device", "card came from
IP". Batched the same way, 100 edges or half a second.

**Step 8. If the fan-out rule fired, ask Neo4j for the ring.** This runs on a
background thread, never inline, because it is the only step that can take tens
of milliseconds. A 5-minute cooldown per card stops the same ring being queried
repeatedly.

**Step 9. Publish.** The alert goes out on Redis Pub/Sub, and the API relays it
to the browser over a WebSocket.

**Step 10. Acknowledge.** `XACK`. Always last.

**Say:** "XACK is last on purpose. If the program crashes anywhere before it,
Redis still has the message marked as pending and delivers it again. That is
at-least-once delivery. The idempotency key and the unique index on txnId make
the repeat harmless."

---

## Part 4 — The four detection rules

All four are plain rules with fixed numbers, not machine learning.
**Say:** "If you ask me why a transaction was flagged, I can give you the exact
numbers, because every alert stores them."

| Rule | Fires when | Redis command behind it | Points |
|---|---|---|---|
| **Velocity** | 5 or more transactions on one card within 60 seconds | `ZCARD` on the card's sorted set | 40 |
| **Amount anomaly** | The amount is above *mean + 3 × standard deviation* of that card's last 20 amounts (needs at least 5) | `ZREVRANGE` on the amounts set | 25 |
| **Impossible travel** | Two consecutive transactions imply a speed over 900 km/h, across at least 200 km | `GEODIST` between the last two points | 70 |
| **Entity fan-out** | One device or one IP has been used by 3 or more different cards within 10 minutes | `ZCARD` on the device / IP set | 55 |

The score is the sum of the points of every rule that fired, capped at 100.
**Low** is 1 to 39, **Medium** 40 to 69, **High** 70 and above.

Worked examples you can quote:

- **Impossible travel:** Chennai to Delhi is about 1,760 km. Two payments 2
  seconds apart imply about 3,168,000 km/h. The limit is 900. Score 70, High.
- **Fan-out + velocity together:** 55 + 40 = 95, High.
- **Amount anomaly alone:** 25, Low. One unusual amount with nothing else
  supporting it deserves a glance, not an escalation.

**Why a sorted set and not a list?** The score is the timestamp, so
`ZREMRANGEBYSCORE` cuts off everything older than the window in one step and
`ZCARD` reads the count instantly. For fan-out, adding the same card twice just
updates its time, so the count is automatically the number of *different* cards.

### How the fake traffic stays innocent

The generator must not trip the rules by accident, or real demonstrations
drown in noise. Three safeguards, each one a guarantee rather than a hope:

- **Velocity:** every card waits at least 20 seconds between payments, so at
  most 4 can fall in any 60 seconds. The limit is 5.
- **Fan-out:** every device and IP is shared by at most 2 cards. The limit is 3.
- **Travel:** every card has one home city and never leaves it.
- **Amount:** every card has a typical spend and stays within 40% of it. About
  1 payment in 3,000 is a deliberate overspend, so the feed shows a gentle
  trickle of Low alerts, roughly 3 a minute.

Only the four **Inject** buttons break these rules, on purpose.

---

## Part 5 — What each database stores

### 5.1 Redis

Everything in Part 3's table, plus:

- `txn:stream` — the incoming log, capped at 100,000 entries.
- `blocklist:cards` — a set of blocked card ids. **The only key with no expiry**,
  because it is a control an analyst issued and it must survive.
- `alerts:live`, `rings:live` — Pub/Sub channels for live updates.

Settings worth knowing:

- **Persistence:** append-only file, flushed every second. After a crash at most
  one second of window data is lost, and the windows refill themselves.
- **Eviction policy `noeviction`:** when memory is full Redis refuses writes
  loudly rather than silently deleting keys. The alternative, `allkeys-lru`,
  could delete the blocklist or the stream's pending list.

### 5.2 MongoDB — database `sentinel`, five collections

| Collection | One document is | Kept for |
|---|---|---|
| `transactions` | one card payment | 24 hours (TTL index) |
| `alerts` | one alert and its whole case history | forever |
| `alerts_archive` | a dismissed alert | 7 days (TTL index) |
| `blocked_cards` | one block, with who and why | forever |
| `ring_snapshots` | one discovered ring | forever |

**The alert document is the key example of "why documents":**

```json
{
  "alertId": "A-0000091", "cardId": "C-0417", "severity": "HIGH", "score": 95,
  "rules": [
    { "type": "VELOCITY", "weight": 40,
      "evidence": { "count": 12, "windowSec": 60, "threshold": 5 } },
    { "type": "IMPOSSIBLE_TRAVEL", "weight": 70,
      "evidence": { "fromCity": "Chennai", "toCity": "Delhi", "km": 1756.3,
                    "seconds": 2.0, "impliedKmh": 3162000.0, "threshold": 900 } }
  ],
  "status": "NEW",
  "notes": [ { "noteId": "n-1", "author": "analyst.yash", "body": "..." } ],
  "statusHistory": [ { "from": null, "to": "NEW", "by": "system" } ]
}
```

**Say:** "Look at the two `evidence` objects. They have completely different
fields, because a velocity rule and a travel rule prove different things. In a
relational table I would need a wide table full of nulls, or a separate
key-value table and a join. Here it is just stored as it is."

**CRUD — the four operations, and where to show each:**

| Operation | In the dashboard | MongoDB call |
|---|---|---|
| **Create** | Triage → **Raise case** | `insertOne` into `alerts` |
| **Read** | Triage queue; open an alert | `find` with filters; an aggregation with `$lookup` |
| **Update** | Change status, assign, add / edit / delete a note | `findOneAndUpdate` with `$set`, `$push`, `$pull` |
| **Delete** | **Dismiss** one; **Clear false positives** | copy to `alerts_archive`, then `deleteOne` / `deleteMany` |

Status changes are checked on the server. The legal path is
New → Investigating → Confirmed fraud or False positive, and either of those can
be reopened. An illegal move is rejected with an error, not silently ignored.
Only New or False positive alerts can be dismissed.

**The 16 indexes.** They are created by code at startup
(`config/MongoIndexConfig.java`) and listed live on the Data stores page.

| # | Collection | Index | Purpose |
|---|---|---|---|
| 1 | transactions | `txnId` unique | safe repeat writes |
| 2 | transactions | `cardId, ts ↓` | one card's history, newest first |
| 3 | transactions | `ts ↓` | recent transactions |
| 4 | transactions | `merchant.category, flagged` | fraud rate by category |
| 5 | transactions | `ingestedAt`, TTL 24 h | automatic deletion |
| 6 | transactions | `loc` 2dsphere | geographic queries |
| 7 | alerts | `alertId` unique | look up one alert |
| 8 | alerts | `severity, ts ↓` | feed ordering |
| 9 | alerts | `cardId, ts ↓` | all alerts for a card |
| **10** | alerts | **`status, severity, ts ↓`** | **the triage queue** |
| 11 | alerts | `txnId` | join to transactions |
| 12 | alerts | `rules.type, ts ↓` | per-rule statistics (multikey) |
| 13 | alerts_archive | `dismissedAt`, TTL 7 d | automatic deletion |
| 14 | blocked_cards | `cardId` unique | block / unblock |
| 15 | ring_snapshots | `discoveredAt ↓` | ring history |
| 16 | alerts_archive | `originalId ↓` | restoring the alert-id counter |

**Index #10 is the one to defend.** It follows the **ESR rule: Equality, Sort,
Range.** The queue is filtered by an exact status and an exact severity
(equality) and then sorted by time. With those two fields first, MongoDB jumps
straight to the matching block of the index and reads it already in time order.
If time came first, it would have to walk the whole time range and filter.

**The five aggregation pipelines:**

| | Shown as | Stages | What it teaches |
|---|---|---|---|
| A | Fraud rate by merchant category | `$match → $group → $match → $addFields → $sort` | grouping and computed fields |
| B | Alerts by severity over time | `$group` with `$dateTrunc`, then `$arrayToObject` | time bucketing, filling empty buckets with zero |
| C | Watchlist (top cards) | `$group`, `$addToSet`, `$reduce` + `$setUnion` | flattening arrays of arrays |
| D | The KPI tiles | `$facet` with `$bucket` and `$unwind` | several statistics in one round trip |
| E | The alert detail drawer | three `$lookup` stages | joining alerts to transactions and blocks |

**Denormalisation, said plainly:** each transaction stores its own `flagged`
and `score`, copied from the alert. That is deliberate duplication so pipeline A
does not need a join on every refresh.

**The cross-database write — blocking a card:**

1. One MongoDB **transaction** writes the block into `blocked_cards` and marks
   that card's alerts.
2. Only after that commits, the card is added to Redis `blocklist:cards`.
3. The consumer's step 1 reads that set, so the card's next payment is declined.

MongoDB is the record of truth; Redis is the fast copy the hot path reads.

### 5.3 Neo4j

**Nodes:** `Card`, `Device`, `Ip`.
**Relationships:** `(Card)-[:USED_DEVICE]->(Device)` and
`(Card)-[:FROM_IP]->(Ip)`, each with a `count`.

The schema in `CLAUDE.md` also defines a `Merchant` node and a `PAID`
relationship, and their uniqueness constraint exists, but the live projector
does not write them. Ring detection only needs devices and IPs. If asked, say
so plainly.

**Why transactions are not nodes:** a transaction is an event, not a thing.
At 150 a second that would be about 13 million nodes a day that nobody ever
traverses. The relationship just carries a counter instead.

**Why `MERGE` and not `CREATE`:** `MERGE` means "find it, or create it if
missing". Processing the same transaction twice then only increases a counter
instead of creating a duplicate edge.

**The ring query**, in words: start at one card, follow device and IP links up
to 6 steps to find every connected card, then keep only the devices and IPs
that at least two of those cards share.

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
RETURN ...
```

- `*1..6` means "between 1 and 6 hops". It is **bounded** because an unlimited
  search over a well-connected graph would crawl most of it, and because cards
  six steps apart are barely related anyway.
- The uniqueness constraint on `cardId` also creates an index, so finding the
  starting card is a direct lookup.

**Say:** "In SQL this is a recursive query that joins the table to itself once
per hop. In Neo4j, moving from a node to its neighbour is following a pointer."

---

## Part 6 — The dashboard, screen by screen

Open http://localhost:3000. The sidebar has five views. The top bar shows the
live rate, the connection status, and which analyst you are acting as (there is
no login; it is a dropdown).

### Live monitor
| Element | What it shows | Where the data comes from |
|---|---|---|
| Six tiles | rate, alerts in the last hour, high, medium, awaiting triage, blocked cards | rate from Redis counters; the rest from pipeline D, refreshed every 3 s |
| Settlement tape | payments as they happen | WebSocket `/topic/txn`, sampled to about 8 rows a second; flagged and declined rows are always shown |
| Fraud patterns | four **Inject** buttons and **Pause traffic** | REST calls to `/api/control/...` |
| Alert feed | new alerts | WebSocket `/topic/alerts` |

The tape is sampled because 150 rows a second cannot be read. Ingestion speed
and display speed are separate concerns.

### Triage
The alert queue with filters for status, severity, rule and card. The
**Query plan** line under the filters is a live `explain()` of the exact query
being run: which index, how many index keys and documents were examined, how
many returned. Click a row to open the case drawer: evidence per rule, the
triggering transaction and the 10 before it (pipeline E), notes, status steps,
assignee, audit trail, and the Block card and Dismiss actions. The right-hand
panel lists blocked cards with an Unblock button.

### Fraud rings
The graph for any card. Circles are cards, squares are devices, diamonds are
IPs, red is a blocked card, the thick outline is the card you searched for.
Hover to isolate a node, click it for details, **Show Cypher** for the query,
**Full screen** for presenting. On the right: rings detected so far, and the
most-shared devices and IPs across the whole graph.

### Analytics
Pipelines A to D as charts, each labelled with its stages, each with a
**Table** button that shows the raw numbers.

### Data stores
A flow strip with live counts, one card per database with its current figures,
and the full index registry with index #10 highlighted.

---

## Part 7 — Before the demo

1. Close heavy applications. The laptop has little free memory.
2. In PowerShell, from the project folder:
   ```powershell
   .\run
   powershell -ExecutionPolicy Bypass -File scripts\smoke.ps1
   ```
   `.\run` stops any earlier session, starts all five programs on freshly
   loaded demo data and opens the dashboard. It takes about two minutes. The
   second command must end with `All checks passed.` When you are finished,
   `.\stop` shuts everything down.
3. Open two browser tabs: http://localhost:3000 and http://localhost:7474
   (log in as `neo4j` / `sentinel-dev`).
4. Wait two minutes. The "Unusual amount" pattern needs cards to have history.

`.\run` loads the same starting data every time: 50,040 transactions,
2,002 alerts, and one clean six-card ring (`C-9001` to `C-9006`, sharing device
`D-SEED-01`), with card `C-9004` already blocked.

---

## Part 8 — The demonstration, step by step

About six minutes.

**1. Live monitor.** Point at the tape and the rate.
**Say:** "This is synthetic card traffic, about 150 transactions a second,
entering through a Redis Stream and being scored as it arrives."

**2. Velocity.** Click **Inject** on *Velocity burst*. After about 7 seconds
Medium alerts appear in the feed.
**Say:** "One card, twelve payments in twenty seconds. The rule is five in sixty.
That count is a Redis sorted set trimmed by timestamp, read with ZCARD. No table
is scanned."

**3. Unusual amount.** Click **Inject** on *Unusual amount*. A Low alert appears.
Open it.
**Say:** "This card normally spends around this much, and just spent three to
four times that. The alert stores the mean, the standard deviation and the
threshold it was compared against."

**4. Impossible travel.** Click **Inject** on *Impossible travel*. Open the High
alert.
**Say:** "Chennai, then Delhi two seconds later. That is GEODIST between the
last two points divided by the time gap. And notice this evidence has different
fields from the previous alert. That is why alerts are documents."

**5. The ring.** Close the drawer. Click **Inject** on *Fraud ring*. After about
6 seconds a "Fraud ring discovered" notice appears.
**Say:** "Six unrelated cards have started using one device. Individually every
one of these payments looks normal. Redis noticed the third card on the same
device, and that is the moment it handed over to the graph database."

**6. Fraud rings view.** Open it from the sidebar; it shows the seeded ring
`C-9001`. Hover a node, click **Show Cypher**, optionally **Full screen**.
**Say:** "One traversal, up to six hops. The red card is already blocked."

**7. Neo4j Browser.** Switch tab and run:
```cypher
MATCH p = (seed:Card {cardId: 'C-9001'})-[:USED_DEVICE|FROM_IP*1..2]-(other:Card)
RETURN p
```
**Say:** "The same graph, straight from the database, outside my own interface."

**8. Triage — CRUD and indexing.** Open **Triage**. Keep **New**, set severity to
**High**.
- Point at the Query plan line. **Say:** "IXSCAN on status, severity, ts. Fifteen
  keys examined for fifteen documents returned. That is the index doing exactly
  the work needed and no more."
- Switch the status to **All** and severity to **Any**. The line turns to
  COLLSCAN and the count jumps to every alert in the collection (about 2,000
  examined to return 15). **Say:** "With no equality filter there is nothing for
  the index to seek on, so MongoDB reads everything and sorts it in memory. Same
  fifteen rows on screen, a hundred times the work. This is the difference an
  index makes, live." Then switch back.
- With **New** but **Any severity**, it is still an index scan but the line
  warns "Sorted in memory": the index is used for the status, yet the results
  are not in time order until severity is fixed too. That is the ESR rule
  showing itself.
- Click an alert. **Start investigating** (Update). Type a note, **Add note**
  (Update with `$push`). Scroll to the audit trail to show it was recorded.
- **Block card**, confirm. **Say:** "One MongoDB transaction, then a write to the
  Redis blocklist."
- Close the drawer. **Raise case** (Create): enter `C-9002`, a reason, submit.
- Open a New alert and **Dismiss** it with a reason (Delete). **Say:** "It is
  copied to an archive collection, then really deleted."

**9. Close the loop.** Back to **Live monitor**, set the tape to **Flagged
only**. Within about 30 seconds the blocked card appears struck through and
marked Declined.
**Say:** "A write to MongoDB has just changed the live stream, through Redis.
That is the three stores working as one system."

**10. If there is time.** **Analytics** for the aggregation pipelines;
**Data stores** for the live counts and all sixteen indexes.

### Which rubric item each step covers

| Requirement | Step |
|---|---|
| Create, Read, Update, Delete | 8 |
| Indexing, with evidence | 8 (Query plan), Data stores page, `docs/evidence/explain-report.md` |
| Aggregation | 10 (Analytics), the tiles in step 1 |
| More than one NoSQL model, justified | 1, 5, 6, 9 |

---

## Part 9 — If something goes wrong

| Symptom | What to do |
|---|---|
| Red banner "API is not responding" | Run `.\run` again; it takes about two minutes |
| A database shows Down in the sidebar | Open http://localhost:8080/api/health to see which, then `.\run` |
| "Unusual amount" gives an error | Traffic has not run long enough. Wait a minute |
| An injected ring shows 30 or more cards | Expected: normal cards share devices in pairs and the traversal follows them. Use `C-9001` for the clean picture |
| An alert says its transaction has expired | Raw transactions are deleted after 24 hours by design. Run `node seed.mjs --wipe` |
| Everything is slow | Close other applications; free memory is the limit on this laptop |

Record one successful run on video beforehand as a backup.

---

## Part 10 — Likely questions and answers

### Redis

**Why a sorted set and not a list for the velocity window?**
The score is the timestamp. `ZREMRANGEBYSCORE` removes everything older than the
window and `ZCARD` gives the count in constant time. A list cannot be cut by
time. Members are also unique, so a repeated delivery does not count twice.

**What happens to the windows if Redis restarts?**
The append-only file is on and flushed every second, so at most a second is
lost. Even a total loss would only cost partial windows of at most an hour, and
they rebuild from new traffic. The blocklist survives, and MongoDB holds its
permanent copy.

**Why consumer groups instead of plain Pub/Sub?**
Pub/Sub is fire-and-forget: if the consumer is down, the message is gone. A
stream keeps the messages, tracks what each consumer has acknowledged, and
redelivers what was not.

**What is `XPENDING`?**
The list of messages delivered to a consumer but not yet acknowledged. A task
runs every 30 seconds, claims anything pending for more than 60 seconds, and
processes it again.

**The consumer crashes mid-transaction. What happens?**
The message was never acknowledged, so it is redelivered. The idempotency key
and the unique `txnId` upsert stop it being counted twice.
*Be honest about one gap:* the idempotency key is set before the work is done.
If processing fails after that point, the redelivery is treated as "already
done" and skipped. So for that case the system is at-most-once. The fix would be
to clear the key on failure. It is written up in `CLAUDE.md` decision D-34.

**What is your eviction policy, and why is `allkeys-lru` wrong?**
`noeviction`. LRU could silently delete the blocklist, which is a compliance
control, or the stream's pending list, which would break redelivery. Memory is
bounded by giving every temporary key an expiry instead.

### Neo4j

**Why are transactions not nodes?** See 5.3: events, not entities; 13 million
useless nodes a day.

**Why is `*1..6` bounded?** Cost and meaning. Unbounded, it tends towards
scanning the whole graph; and six hops is already weak evidence of a link.

**What does the uniqueness constraint give you besides uniqueness?** An index,
so the starting card is found by a seek, not a scan.

**Why `MERGE`?** It makes writes repeatable. A replay increments a count.

**Traversal versus SQL recursive join?** Each hop in Neo4j follows a stored
pointer from a node to its neighbours, so cost depends on the part of the graph
you touch. Each hop in SQL is another join against the whole table's index.

### MongoDB

**What would the shard key be?**
Hashed `cardId`. It spreads cards evenly, keeps one card's history on one shard
(which suits the `cardId, ts` queries), and avoids the hot shard that a
time-based key creates when all new writes go to the latest range.

**Why is the index `{cardId: 1, ts: -1}` in that order?**
Equality first, then sort. All of one card's entries sit together, already
ordered newest first, so no sorting happens in memory.

**Why documents instead of a relational alert table?** The evidence differs per
rule; notes and status history are arrays that belong to the alert and are
always read with it.

**What are change streams, and why not use them?**
A change stream lets a program subscribe to changes in a collection. They are
available here because MongoDB runs as a replica set. I did not use them because
the consumer already has the alert in hand when it inserts it, and publishes it
on Redis directly. A change stream would be a second path for the same
notification.

**What is a TTL index?** An index on a date field with an expiry. MongoDB
deletes documents automatically once they are older than that. Transactions use
24 hours, the archive 7 days.

**Does deleting old transactions break old alerts?** No. The alert keeps its own
copy of the evidence. Only the "triggering transaction" panel becomes empty,
and the screen says so.

### The whole system

**What breaks first at ten times the traffic?**
Three things, in this order. The generator: with a 20-second gap per card, 4,000
cards cannot produce more than 200 a second, so the card pool would have to grow
to 30,000. Then the consumer: it is a single consumer doing several Redis round
trips per transaction, so lag would build up; consumer groups let me add more
consumers. Then the alert insert, which is synchronous.

**CAP theorem — what do you give up?**
Each store is a single node, so within a store there is no partition to
tolerate. Between stores I chose speed over immediate consistency: MongoDB can
be up to half a second behind Redis, and the graph up to half a second behind
that. For the block-card write, MongoDB is updated first and Redis a moment
later.

**What about a transaction that arrives out of order?**
Windows are positioned by the transaction's own timestamp, so it lands in the
right place. But the design assumes timestamps are close to arrival time. The
travel rule only compares when the new transaction is the latest one, so a late
arrival is simply not judged for travel.

**Why not just PostgreSQL?** Part 1's honest counter-argument. Say it before
they finish asking.

**Why rules and not machine learning?** Every flag can be explained with exact
numbers, and the thresholds are in one configuration file.

**What would you do with another month?**
Close the idempotency gap. Make the amount rule compare within a merchant
category. Run several consumers. Add automated tests (there are none yet; it was
verified by a smoke script and by hand). Add real login instead of a dropdown.

---

## Part 11 — Honest limitations

Say these if asked; do not hide them.

- The traffic is synthetic. Nothing is tested against real card data.
- No authentication. The analyst name is a dropdown.
- Every database is a single node. No clustering or sharding is implemented.
- No automated test suite.
- The redelivery gap described in Part 10.
- A ring injected into live traffic can come back much larger than six cards.
- Redis on Windows is a community build; Redis publishes no official one.

---

## Part 12 — Numbers to remember

| | |
|---|---|
| Traffic | about 150 transactions per second |
| Population | 4,000 cards, 2,200 devices, 3,200 IPs, 80 merchants, 12 cities |
| Velocity | 5 in 60 s → 40 points |
| Amount anomaly | above mean + 3σ of last 20 → 25 points |
| Impossible travel | over 900 km/h across 200 km or more → 70 points |
| Entity fan-out | 3 cards on one device or IP in 600 s → 55 points |
| Severity bands | Low 1–39, Medium 40–69, High 70–100 |
| Stream cap | 100,000 entries, about 11 minutes |
| Bulk write | 200 documents or 500 ms |
| Graph batch | 100 edges or 500 ms |
| Retention | transactions 24 h, archive 7 d, alerts forever |
| Indexes | 16 in MongoDB, 4 uniqueness constraints in Neo4j |
| Seed data | 50,040 transactions, 2,002 alerts, one 6-card ring on `C-9001` |
| Live channels | `/topic/txn`, `/topic/alerts`, `/topic/rings` |

## Where things are in the code

| Topic | File (under `api/src/main/java/com/sentinelstream/`) |
|---|---|
| The ten steps | `consumer/TransactionConsumer.java` |
| Stream reading and redelivery | `consumer/StreamConsumerConfig.java` |
| Sliding windows | `detect/WindowService.java` |
| The four rules | `detect/*Detector.java`, `detect/RulesEngine.java` |
| Rule thresholds | `api/src/main/resources/application.yml` |
| Fake traffic | `generator/` |
| Fraud injection | `control/InjectionService.java` |
| Buffered MongoDB writes | `persist/MongoBulkWriter.java` |
| Alert writes | `persist/AlertWriter.java` |
| Triage (CRUD) | `triage/TriageService.java` |
| Block card across stores | `triage/CardBlockService.java` |
| Aggregation pipelines A–D | `stats/StatsService.java` |
| Graph writes | `graph/GraphProjector.java` |
| Ring queries | `graph/RingQueryService.java` |
| Index definitions | `config/MongoIndexConfig.java` |
| Dashboard | `ui/src/views/`, `ui/src/components/` |

The full reference, including every design decision and why it was made, is
`CLAUDE.md` section 8.
