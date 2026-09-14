import { useState } from 'react';
import { useStompTopic } from '../ws.js';

const MAX_ROWS = 200; // CLAUDE.md §6 -- tape DOM cap, oldest-out eviction

// CLAUDE.md §6 / §8 D-05 -- /topic/txn is sampled to ~8 msg/s server-side
// (TxnBroadcaster); flagged rows always pass the sampler. This component
// just renders whatever arrives, newest on top, capped client-side too so a
// long-open tab doesn't grow the DOM unbounded.
export default function SettlementTape() {
  const [rows, setRows] = useState([]);

  useStompTopic('/topic/txn', (txn) => {
    setRows((prev) => [txn, ...prev].slice(0, MAX_ROWS));
  });

  return (
    <div className="panel">
      <div className="panel-title">Settlement tape — live (~8/s sampled, flagged always shown)</div>
      <div className="tape">
        {rows.length === 0 && <div className="empty-state">Waiting for traffic…</div>}
        {rows.map((t) => (
          <div
            key={t.txnId}
            className={`tape-row ${t.declined ? 'declined' : ''} ${t.flagged ? 'flagged' : ''}`}
          >
            <span className="mono">{new Date(Number(t.ts)).toLocaleTimeString()}</span>
            <span className="masked">{'····' + t.cardId.slice(-4)}</span>
            <span>{t.merchantName || '—'}</span>
            <span>{t.city}</span>
            <span className="tabular">₹{Number(t.amount).toFixed(2)}</span>
            {t.declined && <span className="tag">DECLINED</span>}
            {t.flagged && !t.declined && <span className="tag flagged">FLAGGED</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
