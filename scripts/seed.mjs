#!/usr/bin/env node
// CLAUDE.md §3 / PLAN.md Part 7 — deterministic demo state.
// `node scripts/seed.mjs --wipe` reproduces the same demo from cold.
//
// Adaptations from the plan's original text, reconciled against what Slices
// 1-9 actually built (documented in CLAUDE.md §8 D-25):
//   - Population figures follow D-19 (4,000-card live pool), not the plan's
//     pre-correction "500 cards" — this script draws its non-ring cards from
//     within that same C-0001..C-4000 range for id-format consistency, using
//     a smaller working subset since static seed data has no velocity-safety
//     requirement to satisfy.
//   - Index count asserted is 16, not 15 (D-23 added #16 after the plan was
//     written).
//   - Ring shared IPs are 10.10.10.10 / 10.10.10.20, matching the actual
//     InjectionService (control package, Slice 5), not the plan's original
//     placeholder 203.0.113.x.
//   - Step 8 ("warm Redis windows for C-9001 so the travel injector fires
//     on the first shot") is omitted: the travel injector actually built in
//     Slice 5 is self-sufficient — it fires both legs itself and clears any
//     stale window state before doing so (§8 D-21) — so no pre-warming is
//     needed or would help.
//   - Neo4j constraints (§4.4) are created here directly, since the Neo4j
//     projector service (Slice 11) doesn't exist yet; this script owns that
//     narrow slice of §4.4 independently of the projector's runtime code.

import { MongoClient, Double } from 'mongodb';
import neo4j from 'neo4j-driver';
import { createClient } from 'redis';

const WIPE = process.argv.includes('--wipe');

const MONGO_URI = process.env.MONGO_URI ?? 'mongodb://localhost:27017/sentinel?replicaSet=rs0&directConnection=true';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const NEO4J_URI = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER ?? 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? 'sentinel-dev';
const API_BASE = process.env.API_BASE ?? 'http://localhost:8080';

// ---------------------------------------------------------------- mulberry32 PRNG
// 0x5ENT1NEL isn't valid hex (N/T/L aren't hex digits) — it's a mnemonic label,
// not a literal. Same decimal value as the live generator's EntityPool seed
// (api/.../GeneratorProperties default) so both are traceable to one constant.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 1590810094;
const rng = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const randInt = (min, max) => min + Math.floor(rng() * (max - min + 1));
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ---------------------------------------------------------------- reference data (CLAUDE.md §4.6)
const CITIES = [
  { name: 'Delhi', lat: 28.6139, lon: 77.2090 },
  { name: 'Mumbai', lat: 19.0760, lon: 72.8777 },
  { name: 'Chennai', lat: 13.0827, lon: 80.2707 },
  { name: 'Bengaluru', lat: 12.9716, lon: 77.5946 },
  { name: 'Kolkata', lat: 22.5726, lon: 88.3639 },
  { name: 'Hyderabad', lat: 17.3850, lon: 78.4867 },
  { name: 'Ahmedabad', lat: 23.0225, lon: 72.5714 },
  { name: 'Jaipur', lat: 26.9124, lon: 75.7873 },
  { name: 'Lucknow', lat: 26.8467, lon: 80.9462 },
  { name: 'Kochi', lat: 9.9312, lon: 76.2673 },
  { name: 'Guwahati', lat: 26.1445, lon: 91.7362 },
  { name: 'Pune', lat: 18.5204, lon: 73.8567 },
];
const CATEGORIES = [
  { category: 'GROCERY', mcc: '5411', mean: 600, sigma: 0.55, min: 50, max: 3000 },
  { category: 'APPAREL', mcc: '5651', mean: 1800, sigma: 0.60, min: 200, max: 8000 },
  { category: 'ELECTRONICS', mcc: '5732', mean: 8000, sigma: 0.65, min: 500, max: 60000 },
  { category: 'FUEL', mcc: '5541', mean: 1200, sigma: 0.40, min: 200, max: 4000 },
  { category: 'DINING', mcc: '5812', mean: 900, sigma: 0.55, min: 100, max: 5000 },
  { category: 'TRAVEL', mcc: '4722', mean: 5000, sigma: 0.70, min: 500, max: 40000 },
  { category: 'PHARMACY', mcc: '5912', mean: 400, sigma: 0.50, min: 50, max: 2500 },
  { category: 'ENTERTAINMENT', mcc: '7832', mean: 700, sigma: 0.55, min: 100, max: 3000 },
  { category: 'UTILITIES', mcc: '4900', mean: 1500, sigma: 0.35, min: 200, max: 6000 },
  { category: 'JEWELRY', mcc: '5944', mean: 15000, sigma: 0.60, min: 1000, max: 150000 },
];
const RULE_WEIGHTS = { VELOCITY: 40, AMOUNT_ANOMALY: 25, IMPOSSIBLE_TRAVEL: 70, ENTITY_FANOUT: 55 };
function severityOf(score) {
  if (score >= 70) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

const SEED_CARD_COUNT = 800; // subset of the live 4,000-card range (D-19) -- see header note
const DEVICE_COUNT = 400;
const IP_COUNT = 500;
const MERCHANT_COUNT = 80;
const TXN_COUNT = 50_000;
const ALERT_COUNT = 2_000;

const RING_CARD_IDS = ['C-9001', 'C-9002', 'C-9003', 'C-9004', 'C-9005', 'C-9006'];
const RING_DEVICE = 'D-SEED-01';
const RING_IPS = ['10.10.10.10', '10.10.10.20'];

function pad(n, width) { return String(n).padStart(width, '0'); }
function drawAmount(spec) {
  const gaussian = (rng() + rng() + rng() + rng() - 2) / 2; // cheap approx normal via CLT
  const amount = Math.exp(Math.log(spec.mean) + spec.sigma * gaussian);
  return Math.round(Math.min(spec.max, Math.max(spec.min, amount)) * 100) / 100;
}

async function main() {
  console.log(`SentinelStream seed — ${WIPE ? 'WIPE + ' : ''}reproducible demo state`);
  const T0 = new Date(Math.floor(Date.now() / 60000) * 60000);
  console.log(`T0 = ${T0.toISOString()}`);

  await pauseGenerator();

  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  const db = mongo.db();

  const neo4jDriver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const neo4jSession = neo4jDriver.session();

  const redis = createClient({ url: REDIS_URL });
  await redis.connect();

  try {
    if (WIPE) await wipeAll(db, redis, neo4jSession);

    await ensureMongoIndexes(db);
    await ensureNeo4jConstraints(neo4jSession);

    const pools = buildPools();
    const { transactions, alerts } = generateTransactionsAndAlerts(pools, T0);

    console.log(`Inserting ${transactions.length} transactions...`);
    await bulkInsert(db.collection('transactions'), transactions);

    console.log(`Inserting ${alerts.length} alerts...`);
    await bulkInsert(db.collection('alerts'), alerts);

    console.log('Building the seeded ring...');
    const ringSummary = await buildRing(db, neo4jSession, T0);

    console.log('Building triage fixtures (archive + blocked cards)...');
    const fixtureSummary = await buildTriageFixtures(db, redis, T0);

    await resumeGenerator();
    await printSummaryAndAssert(db, neo4jSession, redis, {
      transactions: transactions.length,
      alerts: alerts.length,
      ring: ringSummary,
      fixtures: fixtureSummary,
    });
  } finally {
    await neo4jSession.close();
    await neo4jDriver.close();
    await redis.quit();
    await mongo.close();
  }
}

// ---------------------------------------------------------------- generator control (best-effort)
async function pauseGenerator() {
  try {
    await fetch(`${API_BASE}/api/control/generator/pause`, { method: 'POST' });
    console.log('Generator paused.');
  } catch {
    console.log('API unreachable -- proceeding without pausing (script talks to the stores directly).');
  }
}
async function resumeGenerator() {
  try {
    await fetch(`${API_BASE}/api/control/generator/resume`, { method: 'POST' });
    console.log('Generator resumed.');
  } catch {
    console.log('API unreachable -- skipping resume.');
  }
}

// ---------------------------------------------------------------- wipe
async function wipeAll(db, redis, neo4jSession) {
  console.log('Wiping sentinel collections, Redis, and Neo4j...');
  for (const coll of ['transactions', 'alerts', 'alerts_archive', 'blocked_cards', 'ring_snapshots']) {
    await db.collection(coll).deleteMany({}).catch(() => {});
  }
  await redis.flushDb();
  await neo4jSession.run('MATCH (n) DETACH DELETE n');
}

// ---------------------------------------------------------------- indexes / constraints
async function ensureMongoIndexes(db) {
  const spec = [
    ['transactions', { txnId: 1 }, { unique: true }],
    ['transactions', { cardId: 1, ts: -1 }, {}],
    ['transactions', { ts: -1 }, {}],
    ['transactions', { 'merchant.category': 1, flagged: 1 }, {}],
    ['transactions', { ingestedAt: 1 }, { expireAfterSeconds: 86400 }],
    ['transactions', { loc: '2dsphere' }, {}],
    ['alerts', { alertId: 1 }, { unique: true }],
    ['alerts', { severity: 1, ts: -1 }, {}],
    ['alerts', { cardId: 1, ts: -1 }, {}],
    ['alerts', { status: 1, severity: 1, ts: -1 }, {}],
    ['alerts', { txnId: 1 }, {}],
    ['alerts', { 'rules.type': 1, ts: -1 }, {}],
    ['alerts_archive', { dismissedAt: 1 }, { expireAfterSeconds: 604800 }],
    ['alerts_archive', { originalId: -1 }, {}],
    ['blocked_cards', { cardId: 1 }, { unique: true }],
    ['ring_snapshots', { discoveredAt: -1 }, {}],
  ];
  for (const [coll, key, opts] of spec) {
    await db.collection(coll).createIndex(key, opts);
  }
  console.log(`Ensured ${spec.length} Mongo indexes (CLAUDE.md §4.3, #1-#16).`);
}

async function ensureNeo4jConstraints(session) {
  const stmts = [
    'CREATE CONSTRAINT card_id IF NOT EXISTS FOR (c:Card) REQUIRE c.cardId IS UNIQUE',
    'CREATE CONSTRAINT device_id IF NOT EXISTS FOR (d:Device) REQUIRE d.deviceId IS UNIQUE',
    'CREATE CONSTRAINT ip_addr IF NOT EXISTS FOR (i:Ip) REQUIRE i.ip IS UNIQUE',
    'CREATE CONSTRAINT merch_id IF NOT EXISTS FOR (m:Merchant) REQUIRE m.merchantId IS UNIQUE',
  ];
  for (const stmt of stmts) await session.run(stmt);
  console.log(`Ensured ${stmts.length} Neo4j constraints (CLAUDE.md §4.4).`);
}

// ---------------------------------------------------------------- pools
function buildPools() {
  const cards = Array.from({ length: SEED_CARD_COUNT }, (_, i) => ({
    cardId: `C-${pad(i + 1, 4)}`,
    homeCity: pick(CITIES),
    homeDevice: `D-${pad(randInt(1, DEVICE_COUNT), 4)}`,
    homeIp: `172.${randInt(16, 31)}.${randInt(0, 255)}.${randInt(1, 254)}`,
  }));
  const merchants = [];
  let mid = 1;
  for (const spec of CATEGORIES) {
    for (let i = 0; i < MERCHANT_COUNT / CATEGORIES.length; i++) {
      merchants.push({ id: `M-${pad(mid++, 3)}`, name: `${spec.category[0]}${spec.category.slice(1).toLowerCase()} ${i + 1}`, ...spec });
    }
  }

  // A mild volume tilt (flavour only -- the actual rate lead for pipeline A
  // comes from flagging-quota selection in generateTransactionsAndAlerts,
  // decoupled from volume so it isn't fighting its own denominator).
  const CATEGORY_WEIGHT = { ELECTRONICS: 1.5 };
  const weightedMerchants = merchants.flatMap((m) =>
    Array(Math.round(CATEGORY_WEIGHT[m.category] ?? 1)).fill(m));
  return { cards, merchants, weightedMerchants };
}

// ---------------------------------------------------------------- transactions + correlated alerts
function generateTransactionsAndAlerts(pools, T0) {
  const { cards, weightedMerchants } = pools;
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const now = new Date(); // ingestedAt anchor -- real time, decoupled from synthetic ts (see header)

  const transactions = [];
  const byCategory = {};

  for (let i = 0; i < TXN_COUNT; i++) {
    const card = pick(cards);
    const merchant = pick(weightedMerchants);
    const ts = new Date(T0.getTime() - Math.floor(rng() * dayMs));
    const txnId = `T-SEED-${pad(i + 1, 8)}`;

    transactions.push({
      txnId,
      cardId: card.cardId,
      amount: new Double(drawAmount(merchant)),
      currency: 'INR',
      ts,
      merchant: { id: merchant.id, name: merchant.name, category: merchant.category, mcc: merchant.mcc },
      city: card.homeCity.name,
      loc: { type: 'Point', coordinates: [card.homeCity.lon, card.homeCity.lat] },
      deviceId: card.homeDevice,
      ip: card.homeIp,
      flagged: false,
      score: 0,
      declined: false,
      ingestedAt: now,
    });

    (byCategory[merchant.category] ??= []).push(i);
  }

  // Bias the flagging RATE toward JEWELRY (pipeline A needs a clear leader,
  // not a flat spread) by drawing candidates straight from each category's
  // FULL 24h pool rather than a last-hour-only slice. Two earlier attempts
  // that stayed inside the last-hour slice both hit the same wall: each
  // category's last-hour pool is only ~1/24 of its 24h volume (~200-800
  // transactions), too small a ceiling to reach real dominance without also
  // inflating the category's raw volume (which grows the rate's denominator
  // right along with its numerator, defeating the point). Selecting from the
  // full pool removes that ceiling; the chosen transactions' `ts` is then
  // reassigned into the last hour below, which is what pipeline B (the
  // timeline chart) actually needs -- it was never about where in the full
  // 24h span the candidates originally happened to fall.
  const jewelryPool = shuffle(byCategory.JEWELRY ?? []);
  const jewelryTaken = jewelryPool.slice(0, Math.round(ALERT_COUNT * 0.40));
  const restPool = shuffle(Object.entries(byCategory)
    .filter(([cat]) => cat !== 'JEWELRY')
    .flatMap(([, idxs]) => idxs));
  const candidates = shuffle([...jewelryTaken, ...restPool.slice(0, ALERT_COUNT - jewelryTaken.length)]);

  // Reassign ts (and therefore the resulting alert's ts) into the last hour
  // for every selected candidate, regardless of where it originally fell in
  // the 24h span -- see the comment above.
  for (const i of candidates) {
    transactions[i].ts = new Date(T0.getTime() - Math.floor(rng() * hourMs));
  }

  // Severity mix 60/30/10 (LOW/MEDIUM/HIGH) via fixed rule combinations, not
  // random weight sums -- see CLAUDE.md §5 for why each combination lands
  // where it does.
  const RULE_PLANS = {
    LOW: [['AMOUNT_ANOMALY']],
    MEDIUM: [['VELOCITY'], ['ENTITY_FANOUT'], ['AMOUNT_ANOMALY', 'VELOCITY']],
    HIGH: [['IMPOSSIBLE_TRAVEL'], ['VELOCITY', 'ENTITY_FANOUT'], ['AMOUNT_ANOMALY', 'IMPOSSIBLE_TRAVEL']],
  };
  const bandForIndex = (i) => {
    const frac = i / ALERT_COUNT;
    if (frac < 0.60) return 'LOW';
    if (frac < 0.90) return 'MEDIUM';
    return 'HIGH';
  };

  const STATUS_MIX = [
    ...Array(Math.round(ALERT_COUNT * 0.40)).fill('NEW'),
    ...Array(Math.round(ALERT_COUNT * 0.25)).fill('INVESTIGATING'),
    ...Array(Math.round(ALERT_COUNT * 0.20)).fill('CONFIRMED_FRAUD'),
    ...Array(Math.round(ALERT_COUNT * 0.15)).fill('FALSE_POSITIVE'),
  ];
  while (STATUS_MIX.length < ALERT_COUNT) STATUS_MIX.push('NEW');
  const statusAssignment = shuffle(STATUS_MIX);

  const noteAuthors = ['analyst.yash', 'analyst.dev'];
  const noteBodies = [
    'Checked BIN range, looks consistent with card issuer.',
    'Customer contacted, confirmed the purchase.',
    'Pattern matches a known compromised terminal.',
    'Escalating -- second opinion needed.',
    'Merchant category is unusual for this cardholder.',
  ];

  const alerts = [];
  let alertSeq = 1;

  for (let idx = 0; idx < candidates.length; idx++) {
    const txnIndex = candidates[idx];
    const txn = transactions[txnIndex];
    const band = bandForIndex(idx);
    const ruleTypes = pick(RULE_PLANS[band]);
    const rules = ruleTypes.map((type) => ({ type, weight: RULE_WEIGHTS[type], evidence: evidenceFor(type, txn) }));
    const score = Math.min(100, rules.reduce((s, r) => s + r.weight, 0));
    const severity = severityOf(score);

    txn.flagged = true;
    txn.score = score;

    const status = statusAssignment[idx] ?? 'NEW';
    const statusHistory = [{ from: null, to: 'NEW', by: 'system', at: txn.ts }];
    let resolution = null;
    if (status !== 'NEW') {
      statusHistory.push({ from: 'NEW', to: 'INVESTIGATING', by: pick(noteAuthors), at: txn.ts });
    }
    if (status === 'CONFIRMED_FRAUD') {
      resolution = 'Confirmed fraudulent after review.';
      statusHistory.push({ from: 'INVESTIGATING', to: 'CONFIRMED_FRAUD', by: pick(noteAuthors), at: txn.ts });
    } else if (status === 'FALSE_POSITIVE') {
      resolution = 'Customer confirmed the purchase; false positive.';
      statusHistory.push({ from: 'INVESTIGATING', to: 'FALSE_POSITIVE', by: pick(noteAuthors), at: txn.ts });
    }

    const notes = [];
    if (rng() < 0.10) {
      const n = randInt(1, 4);
      for (let k = 0; k < n; k++) {
        notes.push({
          noteId: `n-${alertSeq}-${k}`,
          author: pick(noteAuthors),
          body: pick(noteBodies),
          at: txn.ts,
          editedAt: null,
        });
      }
    }

    alerts.push({
      alertId: `A-${pad(alertSeq++, 7)}`,
      txnId: txn.txnId,
      cardId: txn.cardId,
      ts: txn.ts,
      severity,
      score,
      origin: 'DETECTOR',
      rules,
      status,
      assignee: status === 'NEW' ? null : pick(noteAuthors),
      notes,
      statusHistory,
      cardBlocked: false,
      resolution,
      updatedAt: txn.ts,
    });
  }

  return { transactions, alerts };
}

function evidenceFor(type, txn) {
  switch (type) {
    case 'AMOUNT_ANOMALY':
      return { amount: txn.amount, mean: Math.round(txn.amount / 4), stddev: Math.round(txn.amount / 8), sigma: 3, threshold: Math.round(txn.amount / 4 + 3 * (txn.amount / 8)), sampleSize: 20 };
    case 'VELOCITY':
      return { count: randInt(5, 14), windowSec: 60, threshold: 5 };
    case 'IMPOSSIBLE_TRAVEL': {
      const from = pick(CITIES.filter((c) => c.name !== txn.city));
      return { fromCity: from.name, toCity: txn.city, km: randInt(400, 2200), seconds: randInt(1, 5), impliedKmh: randInt(500000, 3200000), threshold: 900 };
    }
    case 'ENTITY_FANOUT':
      return { windowSec: 600, threshold: 3, deviceId: txn.deviceId, deviceCardCount: randInt(3, 6) };
    default:
      return {};
  }
}

// ---------------------------------------------------------------- ring
async function buildRing(db, neo4jSession, T0) {
  // Spread the full category spec (mean/sigma/min/max), not just id/name/
  // category/mcc -- an earlier version only copied the display fields, so
  // drawAmount() computed Math.log(undefined) and every ring transaction
  // got amount: NaN, silently (no thrown error; NaN is a valid BSON double).
  const merchants = CATEGORIES.map((c) => ({ ...c, id: `M-RING-${c.category}`, name: `${c.category} Ring Merchant` }));
  const now = new Date();
  const ringTxns = [];
  let seq = 1;

  for (let i = 0; i < 40; i++) {
    const card = pick(RING_CARD_IDS);
    const ip = RING_IPS[i % 2];
    const merchant = pick(merchants);
    const city = pick(CITIES);
    const ts = new Date(T0.getTime() - randInt(0, 30) * 60000);
    ringTxns.push({
      txnId: `T-RING-${pad(seq++, 4)}`,
      cardId: card,
      amount: new Double(drawAmount(merchant)),
      currency: 'INR',
      ts,
      merchant: { id: merchant.id, name: merchant.name, category: merchant.category, mcc: merchant.mcc },
      city: city.name,
      loc: { type: 'Point', coordinates: [city.lon, city.lat] },
      deviceId: RING_DEVICE,
      ip,
      flagged: false,
      score: 0,
      declined: false,
      ingestedAt: now,
    });
  }
  await bulkInsert(db.collection('transactions'), ringTxns);

  // Neo4j projection -- same shape the live projector will write (Slice 11).
  const byCard = new Map();
  for (const t of ringTxns) {
    const key = t.cardId;
    if (!byCard.has(key)) byCard.set(key, { count: 0, firstSeen: t.ts, lastSeen: t.ts, ips: new Set() });
    const agg = byCard.get(key);
    agg.count++;
    agg.ips.add(t.ip);
    if (t.ts < agg.firstSeen) agg.firstSeen = t.ts;
    if (t.ts > agg.lastSeen) agg.lastSeen = t.ts;
  }
  const rows = [...byCard.entries()].map(([cardId, agg]) => ({
    cardId, count: agg.count,
    firstSeen: agg.firstSeen.getTime(), lastSeen: agg.lastSeen.getTime(),
    ips: [...agg.ips],
  }));

  await neo4jSession.run(
    `UNWIND $rows AS row
     MERGE (c:Card {cardId: row.cardId})
       ON CREATE SET c.firstSeen = row.firstSeen, c.txnCount = 0
     SET c.lastSeen = row.lastSeen, c.txnCount = row.count, c.blocked = (row.cardId = 'C-9004')
     MERGE (d:Device {deviceId: $device})
       ON CREATE SET d.firstSeen = row.firstSeen
     SET d.lastSeen = row.lastSeen
     MERGE (c)-[ud:USED_DEVICE]->(d)
       ON CREATE SET ud.count = 0, ud.firstSeen = row.firstSeen
     SET ud.count = row.count, ud.lastSeen = row.lastSeen
     WITH c, row
     UNWIND row.ips AS ip
     MERGE (i:Ip {ip: ip})
       ON CREATE SET i.firstSeen = row.firstSeen
     SET i.lastSeen = row.lastSeen
     MERGE (c)-[fi:FROM_IP]->(i)
       ON CREATE SET fi.count = 0, fi.firstSeen = row.firstSeen
     SET fi.count = fi.count + 1, fi.lastSeen = row.lastSeen`,
    { rows, device: RING_DEVICE },
  );

  // The anchor alert: C-9001, HIGH, NEW -- "the row to click during the demo."
  const anchorTxn = ringTxns.find((t) => t.cardId === 'C-9001') ?? ringTxns[0];
  anchorTxn.flagged = true;
  anchorTxn.score = 95;
  await db.collection('transactions').updateOne({ txnId: anchorTxn.txnId }, { $set: { flagged: true, score: 95 } });

  const anchorAlert = {
    alertId: 'A-9000001',
    txnId: anchorTxn.txnId,
    cardId: 'C-9001',
    ts: anchorTxn.ts,
    severity: 'HIGH',
    score: 95,
    origin: 'DETECTOR',
    rules: [
      { type: 'ENTITY_FANOUT', weight: 55, evidence: { windowSec: 600, threshold: 3, deviceId: RING_DEVICE, deviceCardCount: 6, ip: RING_IPS[0], ipCardCount: 3 } },
      { type: 'VELOCITY', weight: 40, evidence: { count: 7, windowSec: 60, threshold: 5 } },
    ],
    status: 'NEW',
    assignee: null,
    notes: [],
    statusHistory: [{ from: null, to: 'NEW', by: 'system', at: anchorTxn.ts }],
    cardBlocked: false,
    resolution: null,
    updatedAt: anchorTxn.ts,
  };
  // replaceOne+upsert (not insertOne) so a re-run without --wipe stays
  // idempotent instead of hitting alertId's unique index.
  await db.collection('alerts').replaceOne({ alertId: anchorAlert.alertId }, anchorAlert, { upsert: true });

  // A second, quieter alert on C-9004 specifically -- it's the ring member
  // buildTriageFixtures blocks, and without an alert of its own to flag
  // cardBlocked on, pipeline D's blockedCards KPI tile would undercount it.
  const c9004Txn = ringTxns.find((t) => t.cardId === 'C-9004') ?? ringTxns[1];
  const c9004Alert = {
    alertId: 'A-9000002',
    txnId: c9004Txn.txnId,
    cardId: 'C-9004',
    ts: c9004Txn.ts,
    severity: 'MEDIUM',
    score: 55,
    origin: 'DETECTOR',
    rules: [{ type: 'ENTITY_FANOUT', weight: 55, evidence: { windowSec: 600, threshold: 3, deviceId: RING_DEVICE, deviceCardCount: 6, ip: RING_IPS[1], ipCardCount: 3 } }],
    status: 'INVESTIGATING',
    assignee: 'analyst.yash',
    notes: [],
    statusHistory: [
      { from: null, to: 'NEW', by: 'system', at: c9004Txn.ts },
      { from: 'NEW', to: 'INVESTIGATING', by: 'analyst.yash', at: c9004Txn.ts },
    ],
    cardBlocked: false,
    resolution: null,
    updatedAt: c9004Txn.ts,
  };
  await db.collection('alerts').replaceOne({ alertId: c9004Alert.alertId }, c9004Alert, { upsert: true });

  // ring_snapshots -- lets the graph panel render on first load with zero
  // dependence on anything live (implementation plan Part 2/7).
  const sharedEntities = [{ id: RING_DEVICE, type: 'Device', cardCount: RING_CARD_IDS.length }];
  const edges = ringTxns.map((t) => ({ from: t.cardId, to: RING_DEVICE, type: 'USED_DEVICE' }))
    .filter((e, i, arr) => arr.findIndex((x) => x.from === e.from) === i);
  await db.collection('ring_snapshots').deleteMany({ ringId: 'R-0001' }); // re-run idempotency
  await db.collection('ring_snapshots').insertOne({
    ringId: 'R-0001',
    discoveredAt: T0,
    seedCardId: 'C-9001',
    cardIds: RING_CARD_IDS,
    sharedEntities,
    edges,
    hopDepth: 2,
    queryMs: 41,
  });

  console.log(`Ring: ${ringTxns.length} transactions, ${RING_CARD_IDS.length} cards -> ${RING_DEVICE}, anchor alert A-9000001 on C-9001.`);
  return { transactions: ringTxns.length, cards: RING_CARD_IDS.length };
}

// ---------------------------------------------------------------- triage fixtures
async function buildTriageFixtures(db, redis, T0) {
  const archived = [
    { alertId: 'A-8000001', cardId: 'C-0042', status: 'FALSE_POSITIVE', dismissedBy: 'analyst.yash', dismissedAt: new Date(T0.getTime() - 3600000), dismissReason: 'Customer confirmed purchase.', originalId: 'A-8000001' },
    { alertId: 'A-8000002', cardId: 'C-0117', status: 'FALSE_POSITIVE', dismissedBy: 'analyst.dev', dismissedAt: new Date(T0.getTime() - 5400000), dismissReason: 'Known travel pattern for this cardholder.', originalId: 'A-8000002' },
    { alertId: 'A-8000003', cardId: 'C-0256', status: 'NEW', dismissedBy: 'analyst.yash', dismissedAt: new Date(T0.getTime() - 7200000), dismissReason: 'Duplicate of A-8000001.', originalId: 'A-8000003' },
  ];
  await db.collection('alerts_archive').deleteMany({ alertId: { $in: archived.map((a) => a.alertId) } });
  await db.collection('alerts_archive').insertMany(archived);

  const blocked = [
    { cardId: 'C-9004', blockedBy: 'analyst.yash', blockedAt: new Date(T0.getTime() - 1800000), reason: 'Confirmed ring member -- shared device D-SEED-01', sourceAlertId: 'A-9000001', active: true, unblockedAt: null },
    { cardId: 'C-0500', blockedBy: 'analyst.dev', blockedAt: new Date(T0.getTime() - 900000), reason: 'Repeated amount anomalies, customer unreachable.', sourceAlertId: null, active: true, unblockedAt: null },
  ];
  for (const b of blocked) {
    await db.collection('blocked_cards').replaceOne({ cardId: b.cardId }, b, { upsert: true });
    await redis.sAdd('blocklist:cards', b.cardId);
    // Mirror what CardBlockService's live transaction does to alerts.cardBlocked
    // -- otherwise pipeline D's "blockedCards" KPI tile undercounts relative to
    // the real blocked_cards/Redis state (caught by eyeballing the seeded UI:
    // 2 cards genuinely blocked, tile showed 0).
    await db.collection('alerts').updateMany(
      { cardId: b.cardId, status: { $ne: 'FALSE_POSITIVE' } },
      { $set: { cardBlocked: true } },
    );
  }

  console.log(`Triage fixtures: ${archived.length} archived alerts, ${blocked.length} blocked cards (mirrored to Redis).`);
  return { archived: archived.length, blocked: blocked.length };
}

// ---------------------------------------------------------------- bulk insert helper
// Re-running without --wipe regenerates identical ids (the PRNG is seeded), so
// every document collides with one already there -- by design, not a bug: the
// content would be byte-identical anyway. Duplicate-key errors are therefore
// swallowed here so a second run stays idempotent (ends in the same state,
// doesn't crash) rather than needing full bulkWrite-with-upsert semantics for
// 50,000+ documents, which would cost real time against the <60s target for
// a case that only matters if someone runs the script twice in a row.
async function bulkInsert(collection, docs, batchSize = 10000) {
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    try {
      await collection.insertMany(batch, { ordered: false });
    } catch (err) {
      if (err?.code === 11000 || /E11000/.test(err?.message ?? '')) {
        continue; // duplicate key -- expected on a re-run without --wipe
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------- summary + assertions
async function printSummaryAndAssert(db, neo4jSession, redis, expected) {
  console.log('\n--- Summary ---');
  const counts = {};
  for (const coll of ['transactions', 'alerts', 'alerts_archive', 'blocked_cards', 'ring_snapshots']) {
    counts[coll] = await db.collection(coll).countDocuments();
    console.log(`  ${coll}: ${counts[coll]}`);
  }

  const indexCounts = {};
  for (const coll of ['transactions', 'alerts', 'alerts_archive', 'blocked_cards', 'ring_snapshots']) {
    indexCounts[coll] = (await db.collection(coll).listIndexes().toArray()).length;
  }
  const totalIndexes = Object.values(indexCounts).reduce((a, b) => a + b, 0);
  console.log(`  Mongo indexes (incl. _id): ${totalIndexes}`);

  const neo4jCounts = await neo4jSession.run(
    'MATCH (n) OPTIONAL MATCH (n)-[r]->() RETURN count(DISTINCT n) AS nodes, count(r) AS rels',
  );
  const nodes = neo4jCounts.records[0].get('nodes').toNumber();
  const rels = neo4jCounts.records[0].get('rels').toNumber();
  console.log(`  Neo4j: ${nodes} nodes, ${rels} relationships`);

  const redisKeyCount = await redis.dbSize();
  const blocklistMembers = await redis.sMembers('blocklist:cards');
  console.log(`  Redis: ${redisKeyCount} keys, blocklist:cards = [${blocklistMembers.join(', ')}]`);

  const failures = [];
  if (counts.transactions < expected.transactions) failures.push(`transactions ${counts.transactions} < expected ${expected.transactions}`);
  if (counts.alerts < expected.alerts) failures.push(`alerts ${counts.alerts} < expected ${expected.alerts}`);
  if (totalIndexes !== 16 + 5 /* 16 registry + 5 default _id_ */) failures.push(`Mongo index count ${totalIndexes} !== 21 (16 registry + 5 _id_)`);
  if (nodes < RING_CARD_IDS.length + 1 + RING_IPS.length) failures.push(`Neo4j nodes ${nodes} below the expected ring minimum`);
  if (blocklistMembers.length < expected.fixtures.blocked) failures.push(`blocklist:cards has ${blocklistMembers.length} members, expected >= ${expected.fixtures.blocked}`);
  if (!blocklistMembers.includes('C-9004')) failures.push('C-9004 (ring member) missing from blocklist:cards');

  if (failures.length > 0) {
    console.error('\nSEED VERIFICATION FAILED:');
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exitCode = 1;
  } else {
    console.log('\nSeed verified OK.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
