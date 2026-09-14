# SentinelStream

Real-time card fraud detection over polyglot NoSQL persistence (Redis Streams +
MongoDB + Neo4j), Spring Boot backend, React dashboard, Docker Compose.

Course project — see `docs/NoSQL_Project.md` for the design spec and
`CLAUDE.md` for the frozen implementation reference (data models, indexes,
side-effect ordering, decision log).

> This README grows with each build slice (`docs/PLAN.md` Part 6). What
> follows is current through **Slice 12**.

## Prerequisites

- Docker Desktop (with Compose v2 / `docker compose`)
- ~4 GB RAM free for the stack (see CLAUDE.md §2 for per-service limits)

## Run it

```bash
docker compose up -d --build
```

First build compiles the API inside a `gradle:8.8-jdk21` build stage — expect
a few minutes on the first run while dependencies download; subsequent builds
are cached.

Check everything is up:

```bash
curl http://localhost:8080/api/health
```

```json
{
  "status": "UP",
  "stores": { "redis": "UP", "mongo": "UP", "neo4j": "UP" }
}
```

| Service | URL |
|---|---|
| Dashboard (UI) | http://localhost:3000 |
| API | http://localhost:8080 |
| Neo4j Browser | http://localhost:7474 (neo4j / sentinel-dev) |
| Mongo | `mongodb://localhost:27017/sentinel?replicaSet=rs0` |
| Redis | `redis://localhost:6379` |

Tear down:

```bash
docker compose down          # keep data volumes
docker compose down -v       # wipe everything, including the replica set
```

## Status

- [x] Slice 0 — `CLAUDE.md` frozen, repo skeleton
- [x] Slice 1 — Compose stack (Redis / Mongo rs0 / Neo4j / API), `/api/health`
- [x] Slice 2 — generator → `txn:stream` (~150 txn/s, D-19 velocity-safe)
- [x] Slice 3 — consumer group, idempotency, blocklist check, PEL reclaim
- [x] Slice 4 — Mongo write path (validators, 15-index registry, bulk writer)
- [x] Slice 5 — four detectors, scoring, alert persistence, fraud injectors
- [x] Slice 6 — triage API (full CRUD, block-card cross-store transaction)
- [x] Slice 7 — aggregation pipelines A–E
- [x] Slice 8 — `explain()` evidence capture (`docs/evidence/`)
- [x] Slice 9 — minimal UI for the graded path ⛳ **grading gate**
- [x] Slice 10 — seed script, deterministic demo state
- [x] Slice 11 — Neo4j constraints + batched graph projector
- [x] Slice 12 — `RING_FOR_CARD` / `ALL_RINGS` queries, cooldown-gated async
      trigger, `ring_snapshots` persistence
- [ ] Slice 13+ — graph panel, live tape, polish

⛳ **GRADING GATE CLEARED.** CRUD, indexing and aggregation are all
demonstrable live from the dashboard at http://localhost:3000 — no curl
needed. Triage queue (filtered/paged, hits index #10), alert detail drawer
(pipeline E's `$lookup` context, evidence per fired rule), status lifecycle
with only-legal-transitions shown, notes (add/edit/delete), block-card
(cross-store transaction) and dismiss (archive-then-delete), a "Raise case"
button for manual Create, the `$facet` KPI strip polling every 3s, the
Category Risk (pipeline A) and Rule Activity (pipeline B) charts, a
Watchlist leaderboard (pipeline C), and a live index registry viewer
(`GET /api/admin/indexes`) are all wired in and verified against the
running stack.

### UI

React 18 + Vite, served by nginx in production (`ui/Dockerfile`), which
reverse-proxies `/api/*` to the `api` container (`ui/nginx.conf`) — the
browser only ever talks to one origin, so no CORS configuration exists
anywhere. Dev mode: `cd ui && npm install && npm run dev` (Vite proxies
`/api` to `localhost:8080` instead — see `ui/vite.config.js`).

Design tokens follow spec §7.2/7.3 (dark ground, amber/vermilion/teal
accent triad, Space Grotesk + IBM Plex). One deliberate correction: the
spec's own `--text-mute` (`#7D93A3`) sits right at ~4.75:1 contrast on
`--panel` — spec §7.7 flags this exact pair as the one most likely to
fail — so it's lightened (`#9FB0BD`) for real margin. Motion (settlement
tape print-in, ring edge-trace) is Slice 15, deliberately deferred; this
slice is static and functional by design.

### Index evidence

`node scripts/explain-evidence.mjs` (from `scripts/`, `npm install` once)
captures live before/after `explain()` plans for six probe queries — see
[`docs/evidence/explain-report.md`](docs/evidence/explain-report.md).
Latest run: dropping the target index shifted every probe from a
collection scan (or a less-specific fallback index) to the intended
index seek, cutting documents examined by up to **~3,000×**. One negative
control (a regex over note bodies) is included deliberately — no index
helps it, and the report says so rather than only showing green rows.

### Deterministic demo state

```bash
cd scripts && npm install     # once
node seed.mjs --wipe          # ~12s: wipes and reseeds Mongo, Redis, Neo4j
bash smoke.sh                 # ~2s: create/update/delete/aggregate/explain/ring sanity check
```

`--wipe` gives a byte-identical demo every time (seeded `mulberry32` PRNG, no
`Math.random`): 50,000 transactions and 2,000 alerts with a deliberate,
non-uniform shape — JEWELRY carries a **~6× fraud-rate lead** over every
other category (pipeline A's bar chart needs a clear leader, not a flat
spread), severities split 60/30/10 LOW/MEDIUM/HIGH, statuses split
40/25/20/15 NEW/INVESTIGATING/CONFIRMED_FRAUD/FALSE_POSITIVE, and alerts
land across every minute of the last hour so the timeline chart is
populated, not spiky. Plus the seeded ring insurance policy: 6 cards
(`C-9001`…`C-9006`) sharing one device and two IPs, written to both Mongo
*and* Neo4j directly (constraints included — Slice 11's projector doesn't
exist yet, so this script owns that narrow piece of §4.4 on its own), with
a pre-built `ring_snapshots` document and one card (`C-9004`) already
blocked. `C-9001` sits at `NEW`/HIGH — the row to click first.

Re-running without `--wipe` is idempotent: the PRNG is seeded, so a second
run regenerates identical ids and the writes are treated as no-ops rather
than erroring or duplicating.

### Graph projector

`GraphProjector` (batched, non-blocking, mirroring `MongoBulkWriter`'s
shape) turns every processed transaction into `MERGE`d `Card`/`Device`/`Ip`
nodes and `USED_DEVICE`/`FROM_IP` relationships in Neo4j — a bounded queue,
flushed on 100 edges or 500ms, `UNWIND`+`MERGE` in one round trip, never a
synchronous Bolt call on the consumer's hot path. `Neo4jConstraintsConfig`
ensures the four uniqueness constraints (CLAUDE.md §4.4) at boot, the same
`IF NOT EXISTS` idempotency pattern as `MongoIndexConfig`. Live-verified: the
graph grows continuously from organic traffic (confirmed via `cypher-shell`
node/relationship counts climbing over a few seconds), queue depth stays
flat (not backlogging), and the seeded ring from Slice 10 survives untouched
alongside it. `GET /api/admin/mongo-stats` also reports the projector's
queue depth / flush count / dropped count, next to the Mongo bulk writer's.

### Ring queries

`GET /api/rings/{cardId}` runs `RING_FOR_CARD` (bounded `*1..6` traversal,
shared-entity filter — CLAUDE.md §4.4) directly against Neo4j; `GET
/api/rings` runs the global `ALL_RINGS` sweep. When the consumer's
`ENTITY_FANOUT` detector fires, `RingQueryTrigger` runs the same query
asynchronously (cooldown-gated via `ring:cooldown:{cardId}`, never inline on
the hot path) and persists the result through `RingSnapshotWriter` into
`ring_snapshots`, so the demo can re-render a past ring without re-querying
Neo4j. `POST /api/control/inject/ring` fires a fresh 6-card ring on a
newly-generated device/IP identity each call (not the seed script's fixed
`D-SEED-01`, which would otherwise accumulate contamination across repeated
test runs — CLAUDE.md §8 D-30). Live-verified end to end: injecting a ring
produces `"ENTITY_FANOUT fired"` → `"Ring snapshot R-000N persisted"` log
lines within milliseconds, and the seeded ring (`C-9001`) stays at exactly 6
cards across repeated live injections.

**Consumer resilience (§8 D-32).** `scripts/seed.mjs --wipe`'s `FLUSHDB`
deletes `txn:stream` and its consumer group even while the API's own
subscription is live. `StreamConsumerConfig` now survives this without a
restart: the read subscription is built with `cancelOnError(t -> false)` so
a `NOGROUP` read error no longer kills the poll loop outright, and the
existing 30s stale-entry reclaim task detects a missing group (via the full
exception cause chain, not just the top-level message) and recreates it —
so `docker logs` shows `"Processed"` counts continuing straight through a
live `--wipe` with no gap and no manual intervention required.

See `docs/PLAN.md` Part 6 for the full build order and cut list.
