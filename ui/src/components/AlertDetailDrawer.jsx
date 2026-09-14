import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, LEGAL_TRANSITIONS, DELETE_ELIGIBLE, RESOLUTION_REQUIRED } from '../api.js';

const ANALYST = 'analyst.yash'; // no auth in this project (PLAN.md Assumption #2) -- fixed identity

export default function AlertDetailDrawer({ alertId, onClose, onViewRing }) {
  const qc = useQueryClient();
  const [noteBody, setNoteBody] = useState('');
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editBody, setEditBody] = useState('');
  const [pendingResolution, setPendingResolution] = useState(null); // { to }
  const [resolutionText, setResolutionText] = useState('');
  const [error, setError] = useState(null);

  const { data: alert, isLoading } = useQuery({
    queryKey: ['alertDetail', alertId],
    queryFn: () => api.alertDetail(alertId),
    enabled: !!alertId,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['alertDetail', alertId] });
    qc.invalidateQueries({ queryKey: ['alerts'] });
    qc.invalidateQueries({ queryKey: ['kpi'] });
  };

  const statusMutation = useMutation({
    mutationFn: ({ to, resolution }) => api.changeStatus(alertId, { to, by: ANALYST, resolution }),
    onSuccess: () => { invalidate(); setPendingResolution(null); setResolutionText(''); setError(null); },
    onError: (e) => setError(e.message),
  });

  const addNoteMutation = useMutation({
    mutationFn: () => api.addNote(alertId, { author: ANALYST, body: noteBody }),
    onSuccess: () => { setNoteBody(''); invalidate(); },
    onError: (e) => setError(e.message),
  });

  const editNoteMutation = useMutation({
    mutationFn: () => api.editNote(alertId, editingNoteId, { body: editBody }),
    onSuccess: () => { setEditingNoteId(null); invalidate(); },
    onError: (e) => setError(e.message),
  });

  const deleteNoteMutation = useMutation({
    mutationFn: (noteId) => api.deleteNote(alertId, noteId),
    onSuccess: invalidate,
    onError: (e) => setError(e.message),
  });

  const dismissMutation = useMutation({
    mutationFn: () => api.dismiss(alertId, 'Dismissed from triage drawer', ANALYST),
    onSuccess: () => { invalidate(); onClose(); },
    onError: (e) => setError(e.message),
  });

  const blockMutation = useMutation({
    mutationFn: () => api.blockCard(alert.cardId, { reason: `Confirmed via alert ${alertId}`, by: ANALYST, sourceAlertId: alertId }),
    onSuccess: invalidate,
    onError: (e) => setError(e.message),
  });

  const unblockMutation = useMutation({
    mutationFn: () => api.unblockCard(alert.cardId, ANALYST),
    onSuccess: invalidate,
    onError: (e) => setError(e.message),
  });

  if (!alertId) return null;

  const handleTransitionClick = (to) => {
    if (RESOLUTION_REQUIRED.has(to)) {
      setPendingResolution({ to });
      return;
    }
    statusMutation.mutate({ to, resolution: null });
  };

  const submitResolution = () => {
    if (!resolutionText.trim()) return;
    statusMutation.mutate({ to: pendingResolution.to, resolution: resolutionText.trim() });
  };

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-header">
          <div>
            <h3>{alertId}</h3>
            {alert && (
              <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className={`pill ${alert.severity}`}>{alert.severity}</span>
                <span className={`status-pill ${alert.status}`}>{alert.status.replace('_', ' ')}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text-mute)' }}>score {alert.score}</span>
              </div>
            )}
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {isLoading && <div className="empty-state">Loading…</div>}
        {error && <div style={{ color: 'var(--critical)', fontSize: 12, marginBottom: 10 }}>{error}</div>}

        {alert && (
          <>
            <div style={{ fontSize: 12, color: 'var(--text-mute)' }}>
              Card <span className="masked">{'····' + alert.cardId.slice(-4)}</span>
              {alert.blocked && <span style={{ color: 'var(--critical)', marginLeft: 8 }}>● BLOCKED</span>}
            </div>

            {/* Status control -- only legal next states, per §4.5 */}
            <div className="status-row">
              {(LEGAL_TRANSITIONS[alert.status] ?? []).map((to) => (
                <button
                  key={to}
                  className="btn"
                  disabled={statusMutation.isPending}
                  onClick={() => handleTransitionClick(to)}
                >
                  → {to.replace('_', ' ')}
                </button>
              ))}
              {DELETE_ELIGIBLE.has(alert.status) && (
                <button className="btn danger" disabled={dismissMutation.isPending} onClick={() => dismissMutation.mutate()}>
                  Dismiss (delete)
                </button>
              )}
              {onViewRing && (
                <button className="btn" onClick={() => onViewRing(alert.cardId)}>
                  View ring
                </button>
              )}
              {!alert.blocked ? (
                <button className="btn danger" disabled={blockMutation.isPending} onClick={() => blockMutation.mutate()}>
                  Block card
                </button>
              ) : (
                <button className="btn" disabled={unblockMutation.isPending} onClick={() => unblockMutation.mutate()}>
                  Unblock card
                </button>
              )}
            </div>

            {pendingResolution && (
              <div className="panel" style={{ marginBottom: 10 }}>
                <div className="panel-title">Resolution required for {pendingResolution.to.replace('_', ' ')}</div>
                <textarea
                  className="mono"
                  style={{ width: '100%', minHeight: 50, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 3, padding: 6, fontSize: 12 }}
                  value={resolutionText}
                  onChange={(e) => setResolutionText(e.target.value)}
                  placeholder="Why is this being resolved this way?"
                />
                <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                  <button className="btn primary" onClick={submitResolution} disabled={statusMutation.isPending}>Confirm</button>
                  <button className="btn" onClick={() => setPendingResolution(null)}>Cancel</button>
                </div>
              </div>
            )}

            {/* Evidence */}
            <div className="section-label">Evidence — why this fired</div>
            {alert.rules.map((r, i) => (
              <div className="rule-card" key={i}>
                <div className="rule-type">{r.type} · weight {r.weight}</div>
                <pre>{JSON.stringify(r.evidence, null, 2)}</pre>
              </div>
            ))}

            {/* Transaction context — pipeline E's $lookup */}
            <div className="section-label">
              Triggering transaction {alert.txn ? '' : '(expired — TTL, §4.3)'}
            </div>
            {alert.txn && (
              <div className="mini-tape">
                <div className="row">
                  <span>{alert.txn.city}</span>
                  <span>₹{alert.txn.amount}</span>
                  <span>{new Date(alert.txn.ts).toLocaleTimeString()}</span>
                </div>
              </div>
            )}

            <div className="section-label">Prior transactions — joined via $lookup ({alert.priorCount})</div>
            <div className="mini-tape">
              {alert.priorTxns.length === 0 && <div className="row"><span style={{ color: 'var(--text-mute)' }}>No prior history within the 24h TTL window</span></div>}
              {alert.priorTxns.map((t) => (
                <div className={`row ${t.declined ? 'declined' : ''}`} key={t.txnId}>
                  <span>{t.merchant} · {t.city}</span>
                  <span>₹{t.amount}</span>
                  <span>{new Date(t.ts).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>

            {/* Notes */}
            <div className="section-label">Notes</div>
            <div className="notes-list">
              {alert.notes.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-mute)' }}>No notes yet.</div>}
              {alert.notes.map((n) => (
                <div className="note" key={n.noteId}>
                  <div className="meta">{n.author} · {new Date(n.at).toLocaleString()}{n.editedAt ? ' (edited)' : ''}</div>
                  {editingNoteId === n.noteId ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <textarea className="note-form textarea" value={editBody} onChange={(e) => setEditBody(e.target.value)} />
                      <button className="btn primary" onClick={() => editNoteMutation.mutate()}>Save</button>
                      <button className="btn" onClick={() => setEditingNoteId(null)}>Cancel</button>
                    </div>
                  ) : (
                    <>
                      <div>{n.body}</div>
                      <div style={{ marginTop: 4, display: 'flex', gap: 6 }}>
                        <button className="btn" style={{ padding: '2px 8px', fontSize: 10 }} onClick={() => { setEditingNoteId(n.noteId); setEditBody(n.body); }}>Edit</button>
                        <button className="btn" style={{ padding: '2px 8px', fontSize: 10 }} onClick={() => deleteNoteMutation.mutate(n.noteId)}>Delete</button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="note-form">
              <textarea placeholder="Add a note…" value={noteBody} onChange={(e) => setNoteBody(e.target.value)} />
              <button className="btn primary" disabled={!noteBody.trim() || addNoteMutation.isPending} onClick={() => addNoteMutation.mutate()}>
                Post
              </button>
            </div>

            {/* Audit trail */}
            <div className="section-label">Audit trail</div>
            <div className="audit-trail">
              {alert.statusHistory.map((h, i) => (
                <div className="entry" key={i}>
                  {h.from ? `${h.from} → ${h.to}` : `Opened as ${h.to}`} · {h.by} · {new Date(h.at).toLocaleString()}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
