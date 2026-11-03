import { useRef, useState } from 'react';
import { useStompTopic, useStompConnected } from '../ws.js';
import { clock, money } from '../lib/format.js';
import { Empty, Panel, Segmented, SkeletonRows } from './ui.jsx';

const MAX_ROWS = 200; // DOM cap, oldest out

// CLAUDE.md §6 / §8 D-05 -- /topic/txn is sampled to ~8 msg/s server-side;
// flagged and declined rows always pass the sampler. Rows are held in a ref
// while the tape is paused so nothing is lost, only not yet shown.
//
// Flagged and declined rows are also kept in a buffer of their own. Sharing
// the one 200-row buffer, eight ordinary rows a second pushed each of them
// out after about 25 seconds, so "Flagged only" never showed more than that.
const isNotable = (t) => t.flagged || t.declined;
const prepend = (incoming, existing) => [...incoming, ...existing].slice(0, MAX_ROWS);

export default function SettlementTape() {
  const [rows, setRows] = useState([]);
  const [notable, setNotable] = useState([]);
  const [filter, setFilter] = useState('all');
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const held = useRef([]);
  const connected = useStompConnected();
  const everConnected = useRef(false);
  if (connected) everConnected.current = true;

  const show = (incoming) => {
    setRows((prev) => prepend(incoming, prev));
    const flagged = incoming.filter(isNotable);
    if (flagged.length > 0) setNotable((prev) => prepend(flagged, prev));
  };

  useStompTopic('/topic/txn', (txn) => {
    if (pausedRef.current) {
      held.current = prepend([txn], held.current);
      return;
    }
    show([txn]);
  });

  const togglePause = () => {
    const next = !paused;
    pausedRef.current = next;
    setPaused(next);
    if (!next) {
      show(held.current);
      held.current = [];
    }
  };

  const shown = filter === 'all' ? rows : notable;

  return (
    <Panel
      className="tape-panel"
      title="Settlement tape"
      subtitle="Sampled to about 8 rows a second. Flagged and declined rows are always shown."
      flush
      actions={(
        <>
          <Segmented value={filter} onChange={setFilter}
            options={[{ value: 'all', label: 'All' }, { value: 'flagged', label: 'Flagged only' }]} />
          <button className="btn small" onClick={togglePause}>{paused ? 'Resume' : 'Pause'}</button>
        </>
      )}
    >
      {!connected && everConnected.current && (
        <div className="inline-warning">Stream disconnected. Reconnecting in 3s.</div>
      )}
      <div className="tape-head tape-row">
        <span>Time</span><span>Card</span><span>Merchant</span><span>City</span><span className="num">Amount</span><span />
      </div>
      <div className="tape">
        {!connected && !everConnected.current && <SkeletonRows rows={10} />}
        {connected && shown.length === 0 && (
          <Empty
            title={filter === 'all' ? 'Waiting for traffic' : 'No flagged transactions yet'}
            hint={filter === 'all' ? 'If this stays empty, the generator may be paused.' : 'Run a fraud pattern from the panel on the right.'}
          />
        )}
        {shown.map((t) => (
          <div key={t.txnId} className={`tape-row ${t.declined ? 'declined' : t.flagged ? 'flagged' : ''}`}>
            <span className="mono muted">{clock(Number(t.ts))}</span>
            <span className="mono">{t.cardId}</span>
            <span className="ellipsis">{t.merchantName || '—'}</span>
            <span className="muted">{t.city}</span>
            <span className="mono num">{money(t.amount)}</span>
            <span>
              {t.declined && <span className="pill sev-HIGH">Declined</span>}
              {t.flagged && !t.declined && <span className="pill sev-MEDIUM">Flagged</span>}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
