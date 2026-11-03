import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, LEGAL_TRANSITIONS, DELETE_ELIGIBLE, RESOLUTION_REQUIRED } from '../api.js';
import { useApp } from '../app-context.jsx';
import { ANALYSTS, RULE_LABEL, STATUS_LABEL, clock, dateTime, explainRule, money } from '../lib/format.js';
import { Drawer, Empty, ErrorNote, Icon, SeverityPill, SkeletonRows, StatusPill } from './ui.jsx';

const awaitingTransaction = (alert) =>
  !!alert && !!alert.txnId && !alert.txn && Date.now() - new Date(alert.ts).getTime() < 10000;

const LIFECYCLE = ['NEW', 'INVESTIGATING', 'RESOLVED'];
const stageOf = (status) => (status === 'NEW' ? 0 : status === 'INVESTIGATING' ? 1 : 2);

function Section({ title, note, children }) {
  return (
    <section className="case-section">
      <h3>{title}{note && <span className="section-note">{note}</span>}</h3>
      {children}
    </section>
  );
}

// rules[].evidence has a different shape per rule type -- the reason alerts
// are documents (CLAUDE.md §4.2). Rendered generically from whatever keys the
// rule carries, with the raw document one click away.
function EvidenceCard({ rule }) {
  const [raw, setRaw] = useState(false);
  const sentence = explainRule(rule);
  const fields = Object.entries(rule.evidence ?? {});
  return (
    <div className="evidence">
      <header>
        <strong>{RULE_LABEL[rule.type] ?? rule.type}</strong>
        <span className="mono muted">{rule.type}</span>
        <span className="weight">+{rule.weight}</span>
      </header>
      {sentence && <p>{sentence}</p>}
      {raw ? (
        <pre>{JSON.stringify(rule.evidence, null, 2)}</pre>
      ) : (
        <dl className="kv">
          {fields.map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd className="mono">{String(v)}</dd></div>
          ))}
        </dl>
      )}
      <button className="link" onClick={() => setRaw(!raw)}>{raw ? 'Show fields' : 'Show raw document'}</button>
    </div>
  );
}

export default function CaseDrawer({ alertId }) {
  const { analyst, closeCase, navigate, toast, confirm } = useApp();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(null); // { noteId, body }
  const [resolving, setResolving] = useState(null); // target status awaiting a resolution
  const [resolution, setResolution] = useState('');

  const { data: alert, isLoading, error } = useQuery({
    queryKey: ['alertDetail', alertId],
    queryFn: () => api.alertDetail(alertId),
    // An alert is written at once but its transaction goes through the bulk
    // buffer (up to 500 ms, §7 step 5). Opened that quickly, the $lookup finds
    // nothing yet, so keep asking for a few seconds before calling it expired.
    refetchInterval: (query) => (awaitingTransaction(query.state.data) ? 1000 : false),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['alertDetail', alertId] });
    qc.invalidateQueries({ queryKey: ['alerts'] });
    qc.invalidateQueries({ queryKey: ['kpi'] });
    qc.invalidateQueries({ queryKey: ['blocked'] });
  };
  const fail = (title) => (e) => toast({ tone: 'error', title, body: e.message });
  const act = (mutationFn, onSuccess, failTitle) => ({
    mutationFn,
    onSuccess: (...args) => { refresh(); onSuccess?.(...args); },
    onError: fail(failTitle),
  });

  const changeStatus = useMutation(act(
    ({ to, resolution: r }) => api.changeStatus(alertId, { to, by: analyst, resolution: r }),
    (_, { to }) => { setResolving(null); setResolution(''); toast({ title: `Moved to ${STATUS_LABEL[to]}` }); },
    'Status change refused'));
  const assign = useMutation(act((who) => api.assign(alertId, who || null), null, 'Could not assign'));
  const addNote = useMutation(act(() => api.addNote(alertId, { author: analyst, body: note.trim() }), () => setNote(''), 'Could not add note'));
  const editNote = useMutation(act(() => api.editNote(alertId, editing.noteId, { body: editing.body }), () => setEditing(null), 'Could not edit note'));
  const deleteNote = useMutation(act((noteId) => api.deleteNote(alertId, noteId), null, 'Could not delete note'));
  const block = useMutation(act(
    () => api.blockCard(alert.cardId, { reason: `Blocked from alert ${alertId}`, by: analyst, sourceAlertId: alertId }),
    () => toast({ title: `${alert.cardId} blocked`, body: 'Watch the live tape: its next transactions are declined.', action: { label: 'Live monitor', onClick: () => { closeCase(); navigate('live'); } } }),
    'Block failed'));
  const unblock = useMutation(act(() => api.unblockCard(alert.cardId, analyst), () => toast({ title: `${alert.cardId} unblocked` }), 'Unblock failed'));
  // Not built with act(): refreshing this alert's own detail query after it has
  // been deleted would only fetch a 404. Close first, then refresh the lists.
  const dismiss = useMutation({
    mutationFn: (reason) => api.dismiss(alertId, reason, analyst),
    onSuccess: () => {
      closeCase();
      qc.removeQueries({ queryKey: ['alertDetail', alertId] });
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['kpi'] });
      toast({ title: `${alertId} dismissed`, body: 'Archived, then deleted from alerts.' });
    },
    onError: fail('Dismiss refused'),
  });

  const requestTransition = (to) => {
    if (RESOLUTION_REQUIRED.has(to)) setResolving(to);
    else changeStatus.mutate({ to, resolution: null });
  };

  const askBlock = async () => {
    const ok = await confirm({
      title: `Block card ${alert.cardId}?`,
      body: 'One MongoDB transaction records the block and flags this card\'s alerts. The card is then added to the Redis blocklist, and the stream consumer declines it from its next transaction.',
      confirmLabel: 'Block card', danger: true,
    });
    if (ok) block.mutate();
  };

  const askDismiss = async () => {
    const reason = await confirm({
      title: `Dismiss ${alertId}?`,
      body: 'The alert is copied to alerts_archive and then deleted from alerts.',
      reasonLabel: 'Reason for dismissal', confirmLabel: 'Dismiss', danger: true,
    });
    if (reason) dismiss.mutate(reason);
  };

  const stage = alert ? stageOf(alert.status) : 0;

  return (
    <Drawer title={`Alert ${alertId}`} onClose={closeCase}>
      <header className="case-head">
        <div>
          <p className="eyebrow">{alert?.origin === 'ANALYST' ? 'Raised by an analyst' : 'Raised by detectors'}</p>
          <h2 className="mono">{alertId}</h2>
          {alert && (
            <div className="case-pills">
              <SeverityPill value={alert.severity} />
              <StatusPill value={alert.status} />
              <span className="score"><span style={{ width: `${alert.score}%` }} className={`sev-${alert.severity}`} /></span>
              <span className="mono">{alert.score}/100</span>
            </div>
          )}
        </div>
        <button className="icon-btn" onClick={closeCase} aria-label="Close"><Icon name="close" /></button>
      </header>

      <div className="case-body">
        {isLoading && <SkeletonRows rows={8} />}
        {error && <Empty title="This alert is no longer in the queue" hint="It may have been dismissed. Dismissed alerts live in alerts_archive for 7 days." />}

        {alert && (
          <>
            <div className="case-card">
              <div>
                <span className="muted">Card</span>
                <strong className="mono">{alert.cardId}</strong>
                {alert.blocked && <span className="pill sev-HIGH">Blocked</span>}
              </div>
              <div className="row-actions">
                <button className="btn small" onClick={() => { closeCase(); navigate('rings', alert.cardId); }}>
                  <Icon name="rings" size={14} />View ring
                </button>
                {alert.blocked
                  ? <button className="btn small" disabled={unblock.isPending} onClick={() => unblock.mutate()}>Unblock card</button>
                  : <button className="btn small danger" disabled={block.isPending} onClick={askBlock}><Icon name="shield" size={14} />Block card</button>}
              </div>
            </div>

            <Section title="Status">
              <ol className="lifecycle">
                {LIFECYCLE.map((s, i) => (
                  <li key={s} className={i < stage ? 'done' : i === stage ? 'current' : ''}>
                    <span className="step-dot">{i < stage ? <Icon name="check" size={12} /> : i + 1}</span>
                    {s === 'RESOLVED' ? (stage === 2 ? STATUS_LABEL[alert.status] : 'Resolved') : STATUS_LABEL[s]}
                  </li>
                ))}
              </ol>
              {alert.resolution && <p className="resolution">Resolution: {alert.resolution}</p>}
              <div className="row-actions">
                {(LEGAL_TRANSITIONS[alert.status] ?? []).map((to) => (
                  <button key={to} className={`btn ${to === 'CONFIRMED_FRAUD' ? 'danger' : ''}`} disabled={changeStatus.isPending} onClick={() => requestTransition(to)}>
                    {alert.status === 'NEW' ? 'Start investigating' : to === 'INVESTIGATING' ? 'Reopen' : `Mark ${STATUS_LABEL[to].toLowerCase()}`}
                  </button>
                ))}
                {DELETE_ELIGIBLE.has(alert.status) && (
                  <button className="btn" disabled={dismiss.isPending} onClick={askDismiss}><Icon name="trash" size={14} />Dismiss</button>
                )}
                <label className="assign">
                  <span className="muted">Assignee</span>
                  <select value={alert.assignee ?? ''} onChange={(e) => assign.mutate(e.target.value)}>
                    <option value="">Unassigned</option>
                    {ANALYSTS.map((a) => <option key={a}>{a}</option>)}
                  </select>
                </label>
              </div>
              {resolving && (
                <div className="resolve-box">
                  <label className="field">
                    <span>Resolution for "{STATUS_LABEL[resolving]}"</span>
                    <textarea autoFocus rows={2} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="What did you find?" />
                  </label>
                  <div className="row-actions">
                    <button className="btn primary" disabled={!resolution.trim() || changeStatus.isPending}
                      onClick={() => changeStatus.mutate({ to: resolving, resolution: resolution.trim() })}>Confirm</button>
                    <button className="btn" onClick={() => setResolving(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </Section>

            <Section title="Why this fired" note="rules[].evidence">
              {alert.rules.map((r) => <EvidenceCard key={r.type} rule={r} />)}
            </Section>

            <Section title="Transaction context" note="joined with $lookup">
              {alert.txn ? (
                <div className="txn-line trigger">
                  <span className="mono muted">{clock(alert.txn.ts)}</span>
                  <span>{alert.txn.merchant?.name} · {alert.txn.city}</span>
                  <span className="mono num">{money(alert.txn.amount)}</span>
                </div>
              ) : (
                <p className="muted small">
                  {!alert.txnId && 'A manually raised case has no triggering transaction.'}
                  {alert.txnId && awaitingTransaction(alert) && 'The triggering transaction is still in the write buffer. It appears here within a second.'}
                  {alert.txnId && !awaitingTransaction(alert) && 'The triggering transaction has passed its 24 hour retention. The evidence above is the alert\'s own copy.'}
                </p>
              )}
              {alert.priorTxns.length > 0 && <p className="sub-label">{alert.priorCount} earlier on this card</p>}
              {alert.priorTxns.map((t) => (
                <div className={`txn-line ${t.declined ? 'declined' : ''}`} key={t.txnId}>
                  <span className="mono muted">{dateTime(t.ts)}</span>
                  <span>{t.merchant} · {t.city}</span>
                  <span className="mono num">{money(t.amount)}</span>
                </div>
              ))}
            </Section>

            <Section title="Notes" note={`${alert.notes.length}`}>
              {alert.notes.map((n) => (
                <div className="note" key={n.noteId}>
                  <p className="note-meta">{n.author} · {dateTime(n.at)}{n.editedAt ? ' · edited' : ''}</p>
                  {editing?.noteId === n.noteId ? (
                    <>
                      <textarea rows={2} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
                      <div className="row-actions">
                        <button className="btn small primary" disabled={!editing.body.trim() || editNote.isPending} onClick={() => editNote.mutate()}>Save</button>
                        <button className="btn small" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p>{n.body}</p>
                      <div className="row-actions">
                        <button className="link" onClick={() => setEditing({ noteId: n.noteId, body: n.body })}>Edit</button>
                        <button className="link" onClick={() => deleteNote.mutate(n.noteId)}>Delete</button>
                      </div>
                    </>
                  )}
                </div>
              ))}
              <div className="composer">
                <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note" />
                <button className="btn primary" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate()}>Add note</button>
              </div>
            </Section>

            <Section title="Audit trail" note="statusHistory">
              <ol className="audit">
                {alert.statusHistory.map((h, i) => (
                  <li key={i}>
                    <strong>{h.from ? `${STATUS_LABEL[h.from]} to ${STATUS_LABEL[h.to]}` : `Opened as ${STATUS_LABEL[h.to]}`}</strong>
                    <span className="muted">{h.by} · {dateTime(h.at)}</span>
                  </li>
                ))}
              </ol>
            </Section>
          </>
        )}
        {!isLoading && !alert && !error && <ErrorNote error={new Error('No data')} />}
      </div>
    </Drawer>
  );
}
