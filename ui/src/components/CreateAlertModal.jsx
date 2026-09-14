import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';

const ANALYST = 'analyst.yash';

// PLAN.md Part 2 -- Create, analyst-driven: "an analyst opens a case on a
// card with no detector alert." This is the CRUD Create demo pointed at
// from the UI, distinct from the background consumer's own inserts.
export default function CreateAlertModal({ onClose }) {
  const qc = useQueryClient();
  const [cardId, setCardId] = useState('');
  const [severity, setSeverity] = useState('MEDIUM');
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: () => api.createManual({ cardId, severity, reason, author: ANALYST }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['kpi'] });
      onClose();
    },
  });

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer" style={{ width: 380 }}>
        <div className="drawer-header">
          <h3>Raise case</h3>
          <button className="drawer-close" onClick={onClose}>×</button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-mute)' }}>
          Opens a case on a card manually — no detector fired this one. Origin
          is recorded as <code>ANALYST</code>, distinct from <code>DETECTOR</code>.
        </p>
        <div className="section-label" style={{ marginTop: 0 }}>Card ID</div>
        <input
          style={{ width: '100%', background: 'var(--panel-2)', border: '1px solid var(--line)', color: 'var(--text)', padding: 6, borderRadius: 3 }}
          value={cardId} onChange={(e) => setCardId(e.target.value)} placeholder="C-0417"
        />
        <div className="section-label">Severity</div>
        <select style={{ width: '100%' }} value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="LOW">Low</option>
          <option value="MEDIUM">Medium</option>
          <option value="HIGH">High</option>
        </select>
        <div className="section-label">Reason</div>
        <textarea
          style={{ width: '100%', minHeight: 70, background: 'var(--panel-2)', border: '1px solid var(--line)', color: 'var(--text)', padding: 6, borderRadius: 3 }}
          value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why does this card need review?"
        />
        {mutation.isError && <div style={{ color: 'var(--critical)', fontSize: 12, marginTop: 8 }}>{mutation.error.message}</div>}
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button className="btn primary" disabled={!cardId || !reason || mutation.isPending} onClick={() => mutation.mutate()}>
            Create alert
          </button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </>
  );
}
