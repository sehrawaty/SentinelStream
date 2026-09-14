import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';

function timeAgo(iso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function mask(cardId) {
  return '····' + (cardId ?? '').slice(-4);
}

// CLAUDE.md §4.3 index #10 -- filters map to {status, severity, ts} field
// order on purpose: this is the ESR index the queue is built to hit.
export default function TriageQueue({ selectedId, onSelect, onRaiseCase }) {
  const [status, setStatus] = useState('NEW');
  const [severity, setSeverity] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['alerts', status, severity],
    queryFn: () => api.listAlerts({ status, severity, size: 30 }),
    refetchInterval: 5000,
  });

  const items = data?.items ?? [];

  return (
    <div className="panel">
      <div className="panel-title">
        <span>Triage Queue</span>
        <button className="btn primary" onClick={onRaiseCase}>+ Raise case</button>
      </div>

      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="NEW">New</option>
          <option value="INVESTIGATING">Investigating</option>
          <option value="CONFIRMED_FRAUD">Confirmed fraud</option>
          <option value="FALSE_POSITIVE">False positive</option>
        </select>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="">All severities</option>
          <option value="HIGH">High</option>
          <option value="MEDIUM">Medium</option>
          <option value="LOW">Low</option>
        </select>
        <span style={{ marginLeft: 'auto', color: 'var(--text-mute)', fontSize: 11, alignSelf: 'center' }}>
          {data ? `${data.total} total` : ''}
        </span>
      </div>

      {isLoading && <div className="empty-state">Loading…</div>}
      {!isLoading && items.length === 0 && (
        <div className="empty-state">No alerts match these filters. Inject a fraud pattern to see detection live.</div>
      )}

      {items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Rules</th>
                <th>Card</th>
                <th>Status</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr
                  key={a.alertId}
                  className={a.alertId === selectedId ? 'selected' : ''}
                  onClick={() => onSelect(a.alertId)}
                >
                  <td><span className={`pill ${a.severity}`}>{a.severity}</span></td>
                  <td>{(a.rules ?? []).map((r) => r.type).join(', ')}</td>
                  <td className="masked">{mask(a.cardId)}</td>
                  <td><span className={`status-pill ${a.status}`}>{a.status.replace('_', ' ')}</span></td>
                  <td className="tabular">{timeAgo(a.ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
