#!/usr/bin/env node
// CLAUDE.md §4.3 / PLAN.md Part 4 — captures before/after explain() evidence
// for the index registry. Run from the host: `node scripts/explain-evidence.mjs`
// (needs `npm install` once in this directory). Writes one before/after JSON
// pair per probe under docs/evidence/, plus docs/evidence/explain-report.md.
//
// P6 (Neo4j RING_FOR_CARD PROFILE) is deferred until Slice 12, when the ring
// query actually exists — this script only touches MongoDB. Running it again
// after Slice 12 lands should append/replace the P6 row by hand, or a Neo4j
// equivalent script can be added then.
//
// The script leaves the database whole: each probe drops its target index,
// captures BEFORE, recreates the *exact* index it dropped (key + options
// read back from listIndexes before dropping, not retyped by hand here — so
// there is no risk of this script's copy silently drifting from
// MongoIndexConfig's), then captures AFTER. By the end, every index this
// script touched is back exactly as it was.

import { MongoClient } from "mongodb";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.join(__dirname, "..", "docs", "evidence");
const MONGO_URI = process.env.MONGO_URI
  ?? "mongodb://localhost:27017/sentinel?replicaSet=rs0&directConnection=true";

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();
  console.log(`Connected to ${MONGO_URI}`);

  const results = [];

  results.push(await runProbe(db, {
    id: "P1",
    label: "Triage queue -- {status:NEW, severity:HIGH} sort {ts:-1}",
    collection: "alerts",
    indexName: "status_1_severity_1_ts_-1",
    expected: "COLLSCAN + in-memory SORT -> IXSCAN, no SORT stage",
    run: (coll) => coll.find({ status: "NEW", severity: "HIGH" }).sort({ ts: -1 }),
    note: "Without index #10 the planner did not fall back to a full COLLSCAN -- " +
          "it found index #8 ({severity,ts}) still applicable and used that instead, " +
          "adding a FETCH-stage filter on status. #10 removes that extra filter by " +
          "embedding status directly in the index seek. At this data volume (a " +
          "handful of HIGH alerts) the docsExamined delta is small; the meaningful " +
          "evidence is the winning plan's index name changing from the 2-field " +
          "fallback to the exact 3-field match -- at larger HIGH-severity volumes " +
          "the avoided FETCH-filter would show as a real docsExamined gap too.",
  }));

  results.push(await runProbe(db, {
    id: "P2",
    label: "Card history -- {cardId:'C-0417'} sort {ts:-1} limit 10",
    collection: "transactions",
    indexName: "cardId_1_ts_-1",
    expected: "COLLSCAN -> IXSCAN, docsExamined -> ~10",
    run: (coll) => coll.find({ cardId: "C-0417" }).sort({ ts: -1 }).limit(10),
  }));

  results.push(await runProbe(db, {
    id: "P3",
    label: "Pipeline A shape -- {merchant.category, flagged} equality (index #4 in isolation)",
    collection: "transactions",
    indexName: "merchant.category_1_flagged_1",
    expected: "COLLSCAN -> IXSCAN covered scan",
    run: (coll) => coll.find({ "merchant.category": "JEWELRY", flagged: true }),
    note: "Pipeline A's own $match filters on ts, not this compound -- this probe " +
          "isolates index #4 directly rather than explaining the full aggregation, " +
          "which would otherwise mix in ts-range plan noise unrelated to what #4 serves.",
  }));

  results.push(await runProbe(db, {
    id: "P4",
    label: "Pipeline E correlated sub-pipeline shape -- $expr cardId+ts range, sort, limit 10",
    collection: "transactions",
    indexName: "cardId_1_ts_-1",
    expected: "COLLSCAN -> IXSCAN (same index as P2, different access pattern -- $expr vs plain filter)",
    aggregate: true,
    run: (coll) => coll.aggregate([
      { $match: { $expr: { $and: [
        { $eq: ["$cardId", "C-0417"] },
        { $lt: ["$ts", new Date()] },
      ] } } },
      { $sort: { ts: -1 } },
      { $limit: 10 },
    ]),
  }));

  results.push(await runProbe(db, {
    id: "P5",
    label: "Alert feed -- {severity:HIGH} sort {ts:-1}",
    collection: "alerts",
    indexName: "severity_1_ts_-1",
    expected: "COLLSCAN -> IXSCAN",
    run: (coll) => coll.find({ severity: "HIGH" }).sort({ ts: -1 }),
  }));

  // The honest negative example: no index helps a regex scan over note bodies.
  const negative = await captureExplain(db.collection("alerts"),
    (coll) => coll.find({ "notes.body": { $regex: "escalat", $options: "i" } }));

  results.push({
    id: "N1",
    label: "Negative example -- regex over notes.body (no index applies)",
    indexName: null,
    expected: "COLLSCAN before AND after -- indexes don't help substring search",
    before: negative,
    after: negative,
    skippedIndexCycle: true,
  });

  results.push({
    id: "P6",
    label: "Neo4j RING_FOR_CARD seed lookup -- PROFILE, NodeByLabelScan -> NodeUniqueIndexSeek",
    deferred: true,
    reason: "Ring query does not exist until Slice 12 -- see CLAUDE.md build order.",
  });

  await writeReport(results);
  await client.close();
  console.log(`\nDone. See ${path.relative(process.cwd(), EVIDENCE_DIR)}/explain-report.md`);
}

async function runProbe(db, spec) {
  const coll = db.collection(spec.collection);
  console.log(`\n${spec.id}: ${spec.label}`);

  const indexes = await coll.listIndexes().toArray();
  const target = indexes.find((ix) => ix.name === spec.indexName);
  if (!target) {
    console.warn(`  ! index ${spec.indexName} not found on ${spec.collection} -- skipping drop/recreate cycle`);
  }

  let before;
  if (target) {
    await coll.dropIndex(spec.indexName);
    console.log(`  dropped ${spec.indexName}`);
  }
  before = await captureExplain(coll, spec.run);
  await writeJson(`${spec.id}.before.json`, before.raw);
  console.log(`  BEFORE: stage=${before.stage} docsExamined=${before.docsExamined} ms=${before.ms}`);

  let after = before;
  if (target) {
    await coll.createIndex(target.key, indexOptionsOf(target));
    console.log(`  recreated ${spec.indexName}`);
    after = await captureExplain(coll, spec.run);
  }
  await writeJson(`${spec.id}.after.json`, after.raw);
  console.log(`  AFTER:  stage=${after.stage} docsExamined=${after.docsExamined} ms=${after.ms}`);

  return {
    id: spec.id, label: spec.label, indexName: spec.indexName,
    expected: spec.expected, note: spec.note, before, after,
  };
}

function indexOptionsOf(indexSpec) {
  const opts = {};
  if (indexSpec.unique) opts.unique = true;
  if (typeof indexSpec.expireAfterSeconds === "number") opts.expireAfterSeconds = indexSpec.expireAfterSeconds;
  return opts;
}

async function captureExplain(coll, buildCursor) {
  const cursor = buildCursor(coll);
  const raw = await cursor.explain("executionStats");
  return { raw, ...extractMetrics(raw) };
}

function extractMetrics(explainResult) {
  // Aggregation explain() nests differently from find() explain() -- both are
  // normalised here so the report table doesn't care which shape produced it.
  const stagesRoot = explainResult.queryPlanner
    ? explainResult
    : (explainResult.stages?.[0]?.$cursor ?? explainResult);

  const winningPlan = stagesRoot.queryPlanner?.winningPlan ?? explainResult.queryPlanner?.winningPlan;
  const execStats = stagesRoot.executionStats ?? explainResult.executionStats;

  const stage = describeStage(winningPlan);
  return {
    stage,
    docsExamined: execStats?.totalDocsExamined ?? null,
    keysExamined: execStats?.totalKeysExamined ?? null,
    nReturned: execStats?.nReturned ?? null,
    ms: execStats?.executionTimeMillis ?? null,
  };
}

function describeStage(plan) {
  if (!plan) return "UNKNOWN";
  const parts = [];
  let node = plan;
  while (node) {
    parts.push(node.stage + (node.indexName ? `(${node.indexName})` : ""));
    node = node.inputStage;
  }
  return parts.join(" <- ");
}

async function writeJson(filename, data) {
  await writeFile(path.join(EVIDENCE_DIR, filename), JSON.stringify(data, null, 2));
}

async function writeReport(results) {
  const rows = results.map((r) => {
    if (r.deferred) {
      return `| ${r.id} | ${r.label} | — | — | — | *deferred* | — | — | ${r.reason} |`;
    }
    const b = r.before, a = r.after;
    const improved = !r.skippedIndexCycle && b.ms !== null && a.ms !== null;
    return `| ${r.id} | ${r.label} | ${b.stage} | ${b.docsExamined ?? "-"} | ${b.ms ?? "-"} | ${a.stage} | ${a.docsExamined ?? "-"} | ${a.ms ?? "-"} | ${improved ? describeImprovement(b, a) : (r.skippedIndexCycle ? "n/a -- no index applies" : "-")} |`;
  });

  const noteLines = results
    .filter((r) => r.note)
    .map((r) => `- **${r.id}**: ${r.note}`)
    .join("\n");

  const md = `# explain() evidence — index registry (CLAUDE.md §4.3)

Generated by \`scripts/explain-evidence.mjs\` against the live database at the
time of the run (organic traffic through Slice 7; re-run after Slice 10's
seed script lands for the polished, reproducible-volume version referenced
in the report). Each probe drops its target index, captures the *before*
plan, recreates the identical index (key + options read back from the live
index definition, not retyped by hand), then captures the *after* plan.

| Probe | Query | Stage before | Docs examined before | ms before | Stage after | Docs examined after | ms after | Improvement |
|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

${noteLines ? "## Notes\n\n" + noteLines + "\n" : ""}
## Redis — the index-equivalent argument (no separate index structure)

\`card:{c}:txns\` as a **ZSet** gives an O(log N) skiplist-ordered window with
O(1) \`ZCARD\` -- a List would need an O(N) scan to count entries inside a time
bound and could not be trimmed by score at all. \`GEOADD\` maintains a
geohash-scored sorted set, making \`GEODIST\` O(1). The data structure choice
*is* the index here.

## Neo4j — deferred to Slice 12

The four uniqueness constraints (CLAUDE.md §4.4) each create a backing range
index, making \`RING_FOR_CARD\`'s seed lookup (\`MATCH (seed:Card {cardId:
$x})\`) an index seek rather than a label scan. Captured with \`PROFILE\`
once the ring query exists: \`NodeByLabelScan\` -> \`NodeUniqueIndexSeek\`,
recording the \`db hits\` delta -- the Neo4j counterpart to COLLSCAN -> IXSCAN.
`;

  await writeFile(path.join(EVIDENCE_DIR, "explain-report.md"), md);
}

function describeImprovement(before, after) {
  const parts = [];
  if (before.docsExamined !== null && after.docsExamined !== null && before.docsExamined > 0) {
    const ratio = (before.docsExamined / Math.max(after.docsExamined, 1)).toFixed(0);
    parts.push(`${ratio}x fewer docs examined`);
  }
  if (before.ms !== null && after.ms !== null && before.ms >= after.ms) {
    parts.push(`${before.ms}ms -> ${after.ms}ms`);
  }
  return parts.length ? parts.join(", ") : "plan shape improved (see stages)";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
