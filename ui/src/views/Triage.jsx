import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { useApp } from '../app-context.jsx';
import { RULE_LABEL, count, timeAgo } from '../lib/format.js';
import { CardId, Empty, ErrorNote, Icon, Panel, RuleChip, Segmented, SeverityPill, SkeletonRows, StatusPill } from '../components/ui.jsx';
import CreateAlertModal from '../components/CreateAlertModal.jsx';
import Blocklist from '../components/Blocklist.jsx';

const PAGE = 15;
const STATUS_TABS = [
  { value: '', label: 'All' },
  { value: 'NEW', label: 'New' },
  { value: 'INVESTIGATING', label: 'Investigating' },
  { value: 'CONFIRMED_FRAUD', label: 'Confirmed' },
  { value: 'FALSE_POSITIVE', label: 'False positive' },
];

// The explain strip: which index MongoDB actually used for this exact filter,
// and how much work it did. Index #10 {status, severity, ts} is the one the
// queue is built around (CLAUDE.md §4.3).
function QueryPlan({ status, severity }) {
  const { data } = useQuery({
    queryKey: ['alerts', 'explain', status, severity],
    queryFn: () => api.explainQueue({ status, severity, size: PAGE }),
    placeholderData: keepPreviousData,
  });
  if (!data) return null;
  const good = !data.collScan && !data.inMemorySort;
  return (
    <div className={`plan ${good ? 'good' : 'warn'}`}>
      <span className="plan-label"><Icon name="code" size={14} />Query plan</span>
      <span className="plan-stage">{data.collScan ? 'COLLSCAN' : 'IXSCAN'}</span>
      {data.indexName && <span className="mono">{data.indexName}</span>}
      <span>{count(data.keysExamined)} keys and {count(data.docsExamined)} documents examined for {count(data.nReturned)} returned</span>
      <span className="muted">{data.millis} ms</span>
      {data.inMemorySort && <span className="plan-note">Sorted in memory. Pick a severity to read in index order.</span>}
      {data.collScan && <span className="plan-note">No status or severity filter, so no index applies.</span>}
    </div>
  );
}

export default function Triage({ param }) {
  const { openCase, caseId, analyst, toast, confirm } = useApp();
  const qc = useQueryClient();
  const [status, setStatus] = useState(param ? '' : 'NEW');
  const [severity, setSeverity] = useState('');
  const [rule, setRule] = useState('');
  const [cardId, setCardId] = useState(param ?? '');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);

  // Arriving with a card in the URL (from an injector or the watchlist) scopes
  // the queue to that card across every status.
  useEffect(() => {
    if (param) { setCardId(param); setStatus(''); }
  }, [param]);
  useEffect(() => setPage(0), [status, severity, rule, cardId]);

  const filters = { status, severity, rule, cardId: cardId.trim() };
  const { data, isLoading, error } = useQuery({
    queryKey: ['alerts', 'queue', filters, page],
    queryFn: () => api.listAlerts({ ...filters, page, size: PAGE }),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const purge = useMutation({
    mutationFn: () => api.bulkDismiss('FALSE_POSITIVE', analyst),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['kpi'] });
      toast({ title: `${res.deletedCount} alerts deleted`, body: `${res.archived} copied to alerts_archive first` });
    },
    onError: (e) => toast({ tone: 'error', title: 'Bulk dismiss failed', body: e.message }),
  });

  const askPurge = async () => {
    const ok = await confirm({
      title: 'Dismiss every false positive?',
      body: 'Each alert is copied to alerts_archive, then deleted from alerts with a single deleteMany. The archive keeps it for 7 days.',
      confirmLabel: 'Dismiss all', danger: true,
    });
    if (ok) purge.mutate();
  };

  return (
    <div className="triage-grid">
      <Panel
        title="Queue"
        subtitle={`${count(total)} alerts match`}
        flush
        actions={(
          <>
            <button className="btn" onClick={askPurge} disabled={purge.isPending}>
              <Icon name="trash" size={14} />Clear false positives
            </button>
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={14} />Raise case
            </button>
          </>
        )}
      >
        <div className="toolbar">
          <Segmented value={status} onChange={setStatus} options={STATUS_TABS} />
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
            <option value="">Any severity</option>
            <option value="HIGH">High</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
          </select>
          <select value={rule} onChange={(e) => setRule(e.target.value)} aria-label="Rule">
            <option value="">Any rule</option>
            {Object.entries(RULE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <div className="search">
            <Icon name="search" size={14} />
            <input value={cardId} onChange={(e) => setCardId(e.target.value)} placeholder="Card id, e.g. C-9001" aria-label="Card id" />
          </div>
        </div>

        {!rule && !filters.cardId && <QueryPlan status={status} severity={severity} />}
        <ErrorNote error={error} />

        {isLoading && <SkeletonRows rows={8} />}
        {!isLoading && !error && items.length === 0 && (
          <Empty title="No alerts match these filters" hint="Widen the filters, or inject a fraud pattern from the live monitor." />
        )}

        {items.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Severity</th><th>Alert</th><th>Card</th><th>Rules</th>
                  <th className="num">Score</th><th>Status</th><th>Assignee</th><th className="num">Raised</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.alertId} className={a.alertId === caseId ? 'selected' : ''} tabIndex={0}
                    onClick={() => openCase(a.alertId)} onKeyDown={(e) => e.key === 'Enter' && openCase(a.alertId)}>
                    <td><SeverityPill value={a.severity} /></td>
                    <td className="mono">{a.alertId}</td>
                    <td><CardId id={a.cardId} blocked={a.cardBlocked} /></td>
                    <td><span className="chips">{(a.rules ?? []).map((r) => <RuleChip key={r.type} type={r.type} />)}</span></td>
                    <td className="mono num">{a.score}</td>
                    <td><StatusPill value={a.status} /></td>
                    <td className="muted">{a.assignee ?? 'Unassigned'}</td>
                    <td className="muted num">{timeAgo(a.ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > PAGE && (
          <div className="pager">
            <span className="muted">{page * PAGE + 1} to {Math.min(total, (page + 1) * PAGE)} of {count(total)}</span>
            <button className="btn small" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            <button className="btn small" disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </Panel>

      <Blocklist />
      {creating && <CreateAlertModal onClose={() => setCreating(false)} />}
    </div>
  );
}
