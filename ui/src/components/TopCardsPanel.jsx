import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';

// Pipeline C (implementation plan Part 3) -- watchlist leaderboard.
export default function TopCardsPanel({ onSelectCard }) {
  const { data } = useQuery({
    queryKey: ['topCards'],
    queryFn: api.topCards,
    refetchInterval: 15000,
  });

  const rows = data ?? [];

  return (
    <div className="panel">
      <div className="panel-title">Watchlist — top cards by alert count (24h)</div>
      {rows.length === 0 ? (
        <div className="empty-state">No alerts yet.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Card</th>
                <th>Alerts</th>
                <th>High</th>
                <th>Max score</th>
                <th>Rules</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.cardId} onClick={() => onSelectCard?.(c.cardId)}>
                  <td className="masked">
                    {c.masked}
                    {c.blocked && <span style={{ color: 'var(--critical)', marginLeft: 6 }}>●</span>}
                  </td>
                  <td className="tabular">{c.alerts}</td>
                  <td className="tabular" style={{ color: c.high > 0 ? 'var(--critical)' : undefined }}>{c.high}</td>
                  <td className="tabular">{c.maxScore}</td>
                  <td style={{ fontSize: 10, color: 'var(--text-mute)' }}>{c.rules.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
