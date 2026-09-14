import { useRef, useState } from 'react';
import { useStompTopic, useStompConnected } from '../ws.js';

const MAX_ROWS = 200; // CLAUDE.md §6 -- tape DOM cap, oldest-out eviction
const SKELETON_ROWS = 6;

// CLAUDE.md §6 / §8 D-05 -- /topic/txn is sampled to ~8 msg/s server-side
// (TxnBroadcaster); flagged rows always pass the sampler. This component
// just renders whatever arrives, newest on top, capped client-side too so a
// long-open tab doesn't grow the DOM unbounded.
export default function SettlementTape() {
  const [rows, setRows] = useState([]);
  const connected = useStompConnected();
  // Distinguishes "never connected yet" (first load -- show a skeleton) from
  // "was connected, dropped" (show the reconnecting banner instead) -- spec
  // §7.6 wants different treatment for each, not one generic spinner state.
  const everConnected = useRef(false);
  if (connected) everConnected.current = true;

  useStompTopic('/topic/txn', (txn) => {
    setRows((prev) => [txn, ...prev].slice(0, MAX_ROWS));
  });

  return (
    <div className="panel">
      <div className="panel-title">Settlement tape — live (~8/s sampled, flagged always shown)</div>

      {!connected && everConnected.current && (
        // spec §7.6 -- "Errors state what broke and what to do... Never a
        // bare toast." reconnectDelay in ws.js is 3000ms, hence "3s" here --
        // if that constant ever changes, this string needs to move with it.
        <div className="stream-error">Stream disconnected. Reconnecting in 3s.</div>
      )}

      <div className="tape">
        {!connected && !everConnected.current && (
          // spec §7.6 -- "skeleton rows in the tape's exact geometry, so
          // nothing shifts when data arrives" -- same grid, same row height
          // as a real tape-row, just filled with placeholder bars instead of
          // content, so the first live row doesn't jump the layout.
          Array.from({ length: SKELETON_ROWS }).map((_, i) => (
            <div className="tape-row skeleton" key={`sk-${i}`} aria-hidden="true">
              <span className="skeleton-bar" />
              <span className="skeleton-bar" />
              <span className="skeleton-bar" style={{ width: '80%' }} />
              <span className="skeleton-bar" />
              <span className="skeleton-bar" />
            </div>
          ))
        )}
        {connected && rows.length === 0 && (
          <div className="empty-state">Waiting for traffic…</div>
        )}
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
