import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { count } from '../lib/format.js';
import { Icon, Panel, SkeletonRows } from '../components/ui.jsx';

// CLAUDE.md §4.3 -- what each registered index is for, keyed by collection
// and key list, so the live registry can be read against the design.
const INDEX_PURPOSE = {
  'transactions|txnId': [1, 'Idempotent bulk upsert'],
  'transactions|cardId,ts': [2, 'Card history, prior transactions for an alert'],
  'transactions|ts': [3, 'Time range scans'],
  'transactions|merchant.category,flagged': [4, 'Fraud rate by category'],
  'transactions|ingestedAt': [5, 'Expires raw transactions after 24 hours'],
  'transactions|loc': [6, 'Geo queries'],
  'alerts|alertId': [7, 'Lookup by alert id'],
  'alerts|severity,ts': [8, 'Alert feed ordering'],
  'alerts|cardId,ts': [9, 'All alerts for one card'],
  'alerts|status,severity,ts': [10, 'Triage queue: equality, equality, then sort'],
  'alerts|txnId': [11, 'Join key to transactions'],
  'alerts|rules.type,ts': [12, 'Detector activity (multikey)'],
  'alerts_archive|dismissedAt': [13, 'Expires dismissed alerts after 7 days'],
  'blocked_cards|cardId': [14, 'Block and unblock a card'],
  'ring_snapshots|discoveredAt': [15, 'Ring history, newest first'],
  'alerts_archive|originalId': [16, 'Reseeding the alert id counter'],
};

const direction = (k) => (k.direction === 'ASC' ? '1' : k.direction === 'DESC' ? '-1' : '"2dsphere"');
const ttl = (s) => (s == null ? '' : s >= 86400 ? `${s / 86400} d` : `${s} s`);

function Metrics({ rows }) {
  return (
    <dl className="metrics">
      {rows.map(([label, value, note]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd><span className="mono">{value ?? '—'}</span>{note && <span className="muted">{note}</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

function Store({ name, role, up, loading, rows }) {
  return (
    <Panel
      title={name}
      subtitle={role}
      actions={<span className={`conn ${up ? 'ok' : 'down'}`}><span className={`dot ${up ? 'ok' : 'down'}`} />{up ? 'Up' : 'Down'}</span>}
    >
      {loading ? <SkeletonRows rows={5} /> : <Metrics rows={rows} />}
    </Panel>
  );
}

function Flow({ redis, mongo, neo }) {
  const nodes = neo ? Object.values(neo.nodes).reduce((a, b) => a + b, 0) : null;
  const steps = [
    ['Generator', 'Synthetic card traffic', null],
    ['Redis Stream', 'txn:stream', redis && `${count(redis.streamLength)} entries`],
    ['Consumer group', 'Windows and four detectors', redis && `${count(redis.pending)} unacknowledged`],
    ['MongoDB', 'Buffered bulk writes', mongo && `${count(mongo.transactionsCount)} transactions`],
    ['Neo4j', 'Batched graph projection', nodes != null && `${count(nodes)} nodes`],
  ];
  return (
    <Panel title="How a transaction moves" subtitle="Each store does the one job its data model is built for">
      <ol className="flow">
        {steps.map(([name, what, live], i) => (
          <li key={name}>
            <strong>{name}</strong>
            <span>{what}</span>
            <span className="mono flow-live">{live || ' '}</span>
            {i < steps.length - 1 && <span className="flow-arrow"><Icon name="arrow" size={16} /></span>}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

export default function DataStores() {
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 10000, retry: false });
  const { data: redis, isLoading: l1 } = useQuery({ queryKey: ['redisStats'], queryFn: api.redisStats, refetchInterval: 3000 });
  const { data: mongo, isLoading: l2 } = useQuery({ queryKey: ['mongoStats'], queryFn: api.mongoStats, refetchInterval: 3000 });
  const { data: neo, isLoading: l3 } = useQuery({ queryKey: ['neo4jStats'], queryFn: api.neo4jStats, refetchInterval: 5000 });
  const { data: indexes, isLoading: l4 } = useQuery({ queryKey: ['indexes'], queryFn: api.indexes });
  const up = (k) => health?.stores?.[k] === 'UP';

  const indexRows = Object.entries(indexes?.collections ?? {}).flatMap(([coll, list]) =>
    list.map((ix) => {
      const purpose = INDEX_PURPOSE[`${coll}|${ix.keys.map((k) => k.key).join(',')}`];
      return { coll, ...ix, number: purpose?.[0], purpose: purpose?.[1] ?? (ix.name === '_id_' ? 'Default primary key' : '') };
    }));
  const registered = indexRows.filter((r) => r.number).length;

  return (
    <div className="stores-grid">
      <div className="span-3"><Flow redis={redis} mongo={mongo} neo={neo} /></div>

      <Store
        name="Redis" role="Ordered ingestion and sliding-window state" up={up('redis')} loading={l1}
        rows={redis ? [
          ['Stream length', count(redis.streamLength), `of ${count(redis.streamMaxlen)} cap`],
          ['Unacknowledged (PEL)', count(redis.pending), 'redelivered if a consumer dies'],
          ['Consumers', redis.consumers, redis.consumerGroup],
          ['Blocked cards', count(redis.blocklistSize), 'blocklist:cards'],
          ['Keys', count(redis.keys), 'every volatile key has a TTL'],
          ['Memory', redis.usedMemory, `${redis.maxMemoryPolicy}, max ${redis.maxMemory}`],
        ] : []}
      />
      <Store
        name="MongoDB" role="Transactions and alerts, as documents" up={up('mongo')} loading={l2}
        rows={mongo ? [
          ['transactions', count(mongo.transactionsCount), 'kept 24 hours'],
          ['alerts', count(mongo.alertsCount), 'kept indefinitely'],
          ['alerts_archive', count(mongo.alerts_archiveCount), 'kept 7 days'],
          ['blocked_cards', count(mongo.blocked_cardsCount)],
          ['ring_snapshots', count(mongo.ring_snapshotsCount)],
          ['Bulk writer', `${count(mongo.bulkWriterFlushedDocs)} docs`, `${count(mongo.bulkWriterFlushCount)} flushes, ${mongo.bulkWriterQueueDepth} queued, ${mongo.bulkWriterDropped} dropped`],
        ] : []}
      />
      <Store
        name="Neo4j" role="Cards linked to the devices and IPs they use" up={up('neo4j')} loading={l3}
        rows={neo && mongo ? [
          ...Object.entries(neo.nodes).map(([label, n]) => [`${label === 'Ip' ? 'IP' : label} nodes`, count(n)]),
          ...Object.entries(neo.relationships).map(([type, n]) => [type, count(n), 'relationships']),
          ['Graph projector', `${count(mongo.graphProjectorFlushedEdges)} edges`, `${count(mongo.graphProjectorFlushCount)} flushes, ${mongo.graphProjectorQueueDepth} queued, ${mongo.graphProjectorDropped} dropped`],
        ] : []}
      />

      <Panel
        className="span-3"
        title="MongoDB index registry"
        subtitle={indexes ? `${registered} declared indexes, read live from the database` : 'Read live from the database'}
        flush
      >
        {l4 && <SkeletonRows rows={8} />}
        {indexRows.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th className="num">#</th><th>Collection</th><th>Keys</th><th>Kind</th><th>Serves</th></tr>
              </thead>
              <tbody>
                {indexRows.map((r) => (
                  <tr key={`${r.coll}.${r.name}`} className={r.number === 10 ? 'static highlight' : 'static'}>
                    <td className="mono num muted">{r.number ?? ''}</td>
                    <td className="mono">{r.coll}</td>
                    <td className="mono">{`{ ${r.keys.map((k) => `${k.key}: ${direction(k)}`).join(', ')} }`}</td>
                    <td>
                      {r.unique && <span className="chip">Unique</span>}
                      {r.expireAfterSeconds != null && <span className="chip">TTL {ttl(r.expireAfterSeconds)}</span>}
                    </td>
                    <td className="muted">{r.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
