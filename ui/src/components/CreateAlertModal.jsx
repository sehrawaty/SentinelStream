import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { useApp } from '../app-context.jsx';
import { ErrorNote, Field, Modal, Segmented } from './ui.jsx';

// PLAN.md Part 2 -- Create, analyst-driven: a case opened on a card that no
// detector flagged. Stored with origin ANALYST and a null txnId (§8 D-22).
export default function CreateAlertModal({ onClose }) {
  const { analyst, toast, openCase } = useApp();
  const qc = useQueryClient();
  const [cardId, setCardId] = useState('');
  const [severity, setSeverity] = useState('MEDIUM');
  const [reason, setReason] = useState('');

  const create = useMutation({
    mutationFn: () => api.createManual({ cardId: cardId.trim(), severity, reason: reason.trim(), author: analyst }),
    onSuccess: ({ alertId }) => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['kpi'] });
      toast({ title: `Case ${alertId} raised`, action: { label: 'Open', onClick: () => openCase(alertId) } });
      onClose();
    },
  });

  return (
    <Modal
      title="Raise a case"
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!cardId.trim() || !reason.trim() || create.isPending} onClick={() => create.mutate()}>
            Raise case
          </button>
        </>
      )}
    >
      <p className="modal-text">Opens an alert by hand for a card no detector has flagged. It is assigned to you.</p>
      <Field label="Card id">
        <input autoFocus className="mono" value={cardId} onChange={(e) => setCardId(e.target.value)} placeholder="C-0417" />
      </Field>
      <div className="field">
        <span>Severity</span>
        <Segmented value={severity} onChange={setSeverity}
          options={[{ value: 'LOW', label: 'Low' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'HIGH', label: 'High' }]} />
      </div>
      <Field label="Reason">
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why does this card need review?" />
      </Field>
      <ErrorNote error={create.error} />
    </Modal>
  );
}
