import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { useApp } from '../app-context.jsx';
import { useStompTopic } from '../ws.js';
import { timeAgo } from '../lib/format.js';
import { Empty, Panel, RuleChip, SeverityPill, SkeletonRows } from './ui.jsx';

const MAX = 30;

// Backfilled once from the NEW queue, then kept current by /topic/alerts,
// which carries the full alert document (CLAUDE.md §6).
export default function AlertFeed() {
  const { openCase, navigate } = useApp();
  const [live, setLive] = useState([]);
  const { data, isLoading } = useQuery({
    queryKey: ['alerts', 'feed'],
    queryFn: () => api.listAlerts({ status: 'NEW', size: MAX }),
  });

  useStompTopic('/topic/alerts', (alert) => {
    setLive((prev) => [{ ...alert, fresh: true }, ...prev].slice(0, MAX));
  });

  const seen = new Set(live.map((a) => a.alertId));
  const items = [...live, ...(data?.items ?? []).filter((a) => !seen.has(a.alertId))].slice(0, MAX);

  return (
    <Panel
      title="Alert feed"
      subtitle="New alerts as detectors fire"
      flush
      actions={<button className="btn small" onClick={() => navigate('triage')}>Open triage</button>}
    >
      {isLoading && <SkeletonRows rows={5} />}
      {!isLoading && items.length === 0 && (
        <Empty title="No alerts yet" hint="Run a fraud pattern above to see detection live." />
      )}
      <ul className="feed">
        {items.map((a) => (
          <li key={a.alertId}>
            <button className={`feed-row ${a.fresh ? 'fresh' : ''}`} onClick={() => openCase(a.alertId)}>
              <SeverityPill value={a.severity} />
              <span className="feed-main">
                <span className="mono">{a.cardId}</span>
                <span className="chips">{(a.rules ?? []).map((r) => <RuleChip key={r.type} type={r.type} />)}</span>
              </span>
              <span className="feed-side">
                <span className="mono">{a.score}</span>
                <span className="muted">{timeAgo(a.ts)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
