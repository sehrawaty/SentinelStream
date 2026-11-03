import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';
import { useApp } from './app-context.jsx';
import { useStompTopic, useStompConnected } from './ws.js';
import { ANALYSTS } from './lib/format.js';
import { Icon } from './components/ui.jsx';
import CaseDrawer from './components/CaseDrawer.jsx';
import LiveMonitor from './views/LiveMonitor.jsx';
import Triage from './views/Triage.jsx';
import Rings from './views/Rings.jsx';
import Analytics from './views/Analytics.jsx';
import DataStores from './views/DataStores.jsx';

const VIEWS = [
  { id: 'live', label: 'Live monitor', icon: 'live', title: 'Live monitor', blurb: 'Card traffic as it is ingested and scored', Component: LiveMonitor },
  { id: 'triage', label: 'Triage', icon: 'triage', title: 'Alert triage', blurb: 'Review, resolve and dismiss alerts', Component: Triage },
  { id: 'rings', label: 'Fraud rings', icon: 'rings', title: 'Fraud rings', blurb: 'Cards linked through shared devices and IPs', Component: Rings },
  { id: 'analytics', label: 'Analytics', icon: 'chart', title: 'Analytics', blurb: 'MongoDB aggregation pipelines', Component: Analytics },
  { id: 'stores', label: 'Data stores', icon: 'database', title: 'Data stores', blurb: 'What each database holds right now', Component: DataStores },
];

const STORES = [['redis', 'Redis'], ['mongo', 'MongoDB'], ['neo4j', 'Neo4j']];

export default function App() {
  const { route, navigate, analyst, setAnalyst, caseId, toast } = useApp();
  const connected = useStompConnected();
  const qc = useQueryClient();
  const active = VIEWS.find((v) => v.id === route.view) ?? VIEWS[0];

  // The health endpoint answers 503 with the same body when a store is down,
  // so a failed fetch here means the API itself is unreachable.
  const { data: health, isError: apiDown } = useQuery({
    queryKey: ['health'], queryFn: api.health, refetchInterval: 10000, retry: false,
  });
  const { data: rate } = useQuery({ queryKey: ['throughput'], queryFn: api.throughput, refetchInterval: 2000 });
  const { data: kpi } = useQuery({ queryKey: ['kpi'], queryFn: api.kpi, refetchInterval: 3000 });

  // A live alert nudges every alert-derived query to refetch now instead of
  // waiting out its poll interval.
  useStompTopic('/topic/alerts', () => {
    qc.invalidateQueries({ queryKey: ['alerts'] });
    qc.invalidateQueries({ queryKey: ['kpi'] });
  });

  // §7 step 8 -- Redis noticed the fan-out, Neo4j resolved the group. Surface
  // that handoff wherever the analyst happens to be.
  useStompTopic('/topic/rings', (ring) => {
    qc.invalidateQueries({ queryKey: ['ringSnapshots'] });
    qc.invalidateQueries({ queryKey: ['allRings'] });
    toast({
      key: 'ring',
      tone: 'info',
      title: `Fraud ring ${ring.ringId} discovered`,
      body: `${ring.cardCount} linked cards, resolved by Neo4j in ${ring.queryMs} ms`,
      action: { label: 'View ring', onClick: () => navigate('rings', ring.seedCardId) },
    });
  });

  // Braces matter: current Chromium returns a Promise from scrollTo, and React
  // would take a returned value for the effect's cleanup function.
  useEffect(() => { window.scrollTo(0, 0); }, [active.id]);

  const newCount = kpi?.queue?.NEW ?? 0;

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Views">
        <div className="brand">
          <span className="brand-mark"><Icon name="shield" size={18} /></span>
          <span>SentinelStream</span>
        </div>
        <ul>
          {VIEWS.map((v) => (
            <li key={v.id}>
              <button className={v.id === active.id ? 'nav-item active' : 'nav-item'} onClick={() => navigate(v.id)}>
                <Icon name={v.icon} size={18} />
                <span>{v.label}</span>
                {v.id === 'triage' && newCount > 0 && <span className="nav-badge">{newCount}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot">
          <p className="sidebar-label">Stores</p>
          {STORES.map(([key, label]) => {
            const up = !apiDown && health?.stores?.[key] === 'UP';
            return (
              <div className="store-row" key={key}>
                <span className={`dot ${up ? 'ok' : 'down'}`} />
                <span>{label}</span>
                <span className="store-state">{up ? 'Up' : apiDown ? 'No API' : 'Down'}</span>
              </div>
            );
          })}
        </div>
      </nav>

      <div className="content">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{active.title}</h1>
            <p>{active.blurb}</p>
          </div>
          <div className="topbar-meta">
            <div className="rate" title="Measured from Redis per-minute counters">
              <strong>{rate ? Math.round(rate.txnPerSec) : '—'}</strong>
              <span>txn/s</span>
            </div>
            <span className={`conn ${connected ? 'ok' : 'down'}`}>
              <span className={`dot ${connected ? 'ok pulse' : 'down'}`} />
              {connected ? 'Live' : 'Reconnecting'}
            </span>
            <label className="analyst">
              <span>Signed in as</span>
              <select value={analyst} onChange={(e) => setAnalyst(e.target.value)}>
                {ANALYSTS.map((a) => <option key={a}>{a}</option>)}
              </select>
            </label>
          </div>
        </header>

        {apiDown && (
          <div className="banner" role="alert">
            <Icon name="alert" />
            The API on port 8080 is not responding. Start the stack with <code>scripts\native\start-native.ps1</code>; this page reconnects on its own.
          </div>
        )}

        <main className="view">
          <active.Component param={route.param} />
        </main>
      </div>

      {caseId && <CaseDrawer alertId={caseId} />}
    </div>
  );
}
