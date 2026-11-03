import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { useApp } from '../app-context.jsx';
import { Icon, Panel } from './ui.jsx';

// CLAUDE.md §5 injectable patterns. `seconds` is how long the server keeps
// emitting after the call returns, which is what the progress bar tracks.
const PATTERNS = [
  {
    id: 'velocity', icon: 'zap', name: 'Velocity burst', seconds: 20, run: api.injectVelocity,
    what: 'One card makes 12 transactions in 20 seconds.',
    expect: 'Velocity fires on the 5th transaction. Medium, score 40.',
  },
  {
    id: 'amount', icon: 'alert', name: 'Unusual amount', seconds: 2, run: api.injectAmount,
    what: 'One card spends three to four times its usual ticket.',
    expect: 'Amount anomaly fires against the card\'s own last 20 payments. Low, score 25.',
  },
  {
    id: 'travel', icon: 'plane', name: 'Impossible travel', seconds: 3, run: api.injectTravel,
    what: 'One card pays in Chennai, then in Delhi two seconds later.',
    expect: 'Impossible travel fires on the second payment. High, score 70.',
  },
  {
    id: 'ring', icon: 'rings', name: 'Fraud ring', seconds: 12, run: api.injectRing,
    what: 'Six unrelated cards start using one device and two IPs.',
    expect: 'Fan-out fires from the 3rd card on (medium, score 55), then Neo4j resolves the group.',
  },
];

export default function InjectorPanel() {
  const { navigate, toast } = useApp();
  const qc = useQueryClient();
  const [runs, setRuns] = useState({}); // id -> { running, cards }

  const { data: generator } = useQuery({
    queryKey: ['generator'], queryFn: api.generatorStatus, refetchInterval: 5000,
  });
  const toggleGenerator = useMutation({
    mutationFn: () => (generator?.paused ? api.generatorResume() : api.generatorPause()),
    onSuccess: (status) => qc.setQueryData(['generator'], status),
    onError: (e) => toast({ tone: 'error', title: 'Could not change the generator', body: e.message }),
  });

  const fire = async (p) => {
    setRuns((r) => ({ ...r, [p.id]: { running: true } }));
    try {
      const res = await p.run();
      const cards = res.cardIds ?? [res.cardId];
      setRuns((r) => ({ ...r, [p.id]: { running: true, cards } }));
      setTimeout(() => setRuns((r) => ({ ...r, [p.id]: { running: false, cards } })), p.seconds * 1000);
    } catch (e) {
      setRuns((r) => ({ ...r, [p.id]: { running: false } }));
      toast({ tone: 'error', title: `${p.name} failed`, body: e.message });
    }
  };

  return (
    <Panel
      title="Fraud patterns"
      subtitle="Inject a known pattern into the live stream"
      actions={(
        <button className="btn small" disabled={!generator || toggleGenerator.isPending} onClick={() => toggleGenerator.mutate()}>
          <Icon name={generator?.paused ? 'play' : 'pause'} size={14} />
          {generator?.paused ? 'Resume traffic' : 'Pause traffic'}
        </button>
      )}
    >
      {generator?.paused && (
        <div className="inline-warning">Background traffic is paused. Injected patterns still flow.</div>
      )}
      <div className="patterns">
        {PATTERNS.map((p) => {
          const run = runs[p.id];
          return (
            <div className="pattern" key={p.id}>
              <span className="pattern-icon"><Icon name={p.icon} size={18} /></span>
              <div className="pattern-text">
                <strong>{p.name}</strong>
                <span>{p.what}</span>
                <span className="muted">{p.expect}</span>
                {run?.cards && (
                  <span className="pattern-result">
                    <span className="mono">{run.cards.length > 1 ? `${run.cards.length} cards from ${run.cards[0]}` : run.cards[0]}</span>
                    {p.id === 'ring'
                      ? <button className="link" onClick={() => navigate('rings', run.cards[0])}>View ring</button>
                      : <button className="link" onClick={() => navigate('triage', run.cards[0])}>See its alerts</button>}
                  </span>
                )}
              </div>
              <button className="btn primary" disabled={run?.running} onClick={() => fire(p)}>
                {run?.running ? 'Running' : 'Inject'}
              </button>
              {run?.running && <span className="pattern-progress" style={{ animationDuration: `${p.seconds}s` }} />}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
