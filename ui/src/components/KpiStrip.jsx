import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';

// CLAUDE.md §6 -- the KPI strip polls the $facet pipeline (D) every 3s
// rather than being a fourth STOMP channel, per the frozen channel count.
export default function KpiStrip() {
  const { data } = useQuery({
    queryKey: ['kpi'],
    queryFn: api.kpi,
    refetchInterval: 3000,
  });

  const bySeverity = data?.bySeverity ?? { LOW: 0, MEDIUM: 0, HIGH: 0 };
  const queue = data?.queue ?? {};
  const newCount = queue.NEW ?? 0;
  const investigating = queue.INVESTIGATING ?? 0;

  return (
    <div className="kpi-strip">
      <div className="kpi">
        <span className="label">Alerts (60m)</span>
        <span className="value tabular">{data?.alerts ?? '—'}</span>
      </div>
      <div className="kpi">
        <span className="label">High</span>
        <span className="value high tabular">{bySeverity.HIGH}</span>
      </div>
      <div className="kpi">
        <span className="label">Medium</span>
        <span className="value medium tabular">{bySeverity.MEDIUM}</span>
      </div>
      <div className="kpi">
        <span className="label">New</span>
        <span className="value tabular">{newCount}</span>
      </div>
      <div className="kpi">
        <span className="label">Investigating</span>
        <span className="value tabular">{investigating}</span>
      </div>
      <div className="kpi">
        <span className="label">Blocked cards</span>
        <span className="value tabular">{data?.blockedCards ?? 0}</span>
      </div>
    </div>
  );
}
