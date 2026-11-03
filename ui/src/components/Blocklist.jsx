import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { useApp } from '../app-context.jsx';
import { dateTime } from '../lib/format.js';
import { Empty, Panel, SkeletonRows } from './ui.jsx';

// blocked_cards is the durable record; Redis blocklist:cards is the hot-path
// mirror the consumer checks first (CLAUDE.md §4.2, §7 step 1). Unblocking
// here reverses both, so the cross-store write can be shown again.
export default function Blocklist() {
  const { analyst, toast, navigate } = useApp();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['blocked'], queryFn: api.blockedCards, refetchInterval: 8000 });

  const unblock = useMutation({
    mutationFn: (cardId) => api.unblockCard(cardId, analyst),
    onSuccess: (_, cardId) => {
      qc.invalidateQueries({ queryKey: ['blocked'] });
      qc.invalidateQueries({ queryKey: ['alertDetail'] });
      toast({ title: `${cardId} unblocked`, body: 'Removed from the Redis blocklist. Its transactions are scored again.' });
    },
    onError: (e) => toast({ tone: 'error', title: 'Unblock failed', body: e.message }),
  });

  const rows = data ?? [];
  return (
    <Panel title="Blocked cards" subtitle="Declined at the stream before any detector runs" flush>
      {isLoading && <SkeletonRows rows={3} />}
      {!isLoading && rows.length === 0 && (
        <Empty title="No cards are blocked" hint="Open an alert and block its card to see declines on the live tape." />
      )}
      <ul className="blocklist">
        {rows.map((b) => (
          <li key={b.cardId}>
            <div>
              <button className="link mono" onClick={() => navigate('triage', b.cardId)}>{b.cardId}</button>
              <p>{b.reason}</p>
              <p className="muted">{b.blockedBy}, {dateTime(b.blockedAt)}</p>
            </div>
            <button className="btn small" disabled={unblock.isPending} onClick={() => unblock.mutate(b.cardId)}>Unblock</button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
