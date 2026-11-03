import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { count } from '../lib/format.js';
import SettlementTape from '../components/SettlementTape.jsx';
import AlertFeed from '../components/AlertFeed.jsx';
import InjectorPanel from '../components/InjectorPanel.jsx';

function Tile({ label, value, note, tone }) {
  return (
    <div className={`tile ${tone ? `tone-${tone}` : ''}`}>
      <span className="tile-label">{label}</span>
      <strong className="tile-value">{value}</strong>
      <span className="tile-note">{note}</span>
    </div>
  );
}

export default function LiveMonitor() {
  // Same query keys as the shell, so React Query shares one poll between them.
  const { data: kpi } = useQuery({ queryKey: ['kpi'], queryFn: api.kpi, refetchInterval: 3000 });
  const { data: rate } = useQuery({ queryKey: ['throughput'], queryFn: api.throughput, refetchInterval: 2000 });
  const sev = kpi?.bySeverity ?? {};
  const queue = kpi?.queue ?? {};

  return (
    <>
      <div className="tiles">
        <Tile label="Throughput" value={rate ? `${Math.round(rate.txnPerSec)}/s` : '—'} note="Redis Stream ingest" />
        <Tile label="Alerts" value={count(kpi?.alerts)} note="Last 60 minutes" />
        <Tile label="High severity" value={count(sev.HIGH)} note="Score 70 and above" tone="high" />
        <Tile label="Medium severity" value={count(sev.MEDIUM)} note="Score 40 to 69" tone="medium" />
        <Tile label="Awaiting triage" value={count(queue.NEW ?? (kpi ? 0 : null))} note={`${count(queue.INVESTIGATING ?? 0)} under investigation`} />
        <Tile label="Blocked cards" value={count(kpi?.blockedCards)} note="Declined at the stream" />
      </div>

      <div className="live-grid">
        <SettlementTape />
        <div className="stack">
          <InjectorPanel />
          <AlertFeed />
        </div>
      </div>
    </>
  );
}
