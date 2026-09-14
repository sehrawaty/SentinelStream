# SentinelStream

Real-time card fraud detection over polyglot NoSQL persistence (Redis Streams +
MongoDB + Neo4j), Spring Boot backend, React dashboard, Docker Compose.

Course project — see `docs/NoSQL_Project.md` for the design spec and
`CLAUDE.md` for the frozen implementation reference (data models, indexes,
side-effect ordering, decision log).

> This README grows with each build slice (`docs/PLAN.md` Part 6). What
> follows is current through **Slice 9**.

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
- [ ] Slice 10 — seed script
- [ ] Slice 11+ — Neo4j projector, ring queries, graph panel, live tape, polish

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

See `docs/PLAN.md` Part 6 for the full build order and cut list.
