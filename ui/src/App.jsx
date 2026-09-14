import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import KpiStrip from './components/KpiStrip.jsx';
import TriageQueue from './components/TriageQueue.jsx';
import AlertDetailDrawer from './components/AlertDetailDrawer.jsx';
import CategoryRiskChart from './components/CategoryRiskChart.jsx';
import SeverityTimelineChart from './components/SeverityTimelineChart.jsx';
import TopCardsPanel from './components/TopCardsPanel.jsx';
import AdminIndexDrawer from './components/AdminIndexDrawer.jsx';
import CreateAlertModal from './components/CreateAlertModal.jsx';
import InjectorControls from './components/InjectorControls.jsx';
import RingPanel from './components/RingPanel.jsx';
import SettlementTape from './components/SettlementTape.jsx';
import { useStompTopic, useStompConnected } from './ws.js';

export default function App() {
  const [selectedAlertId, setSelectedAlertId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [ringCardId, setRingCardId] = useState(null);
  const connected = useStompConnected();
  const qc = useQueryClient();

  // A live alert (/topic/alerts, unsampled -- §6) nudges the queue/KPI
  // queries to refetch immediately instead of waiting out their poll
  // interval (TriageQueue 5s, KpiStrip 3s) -- the same data, just faster
  // to appear once the WS pipe already told us something changed.
  useStompTopic('/topic/alerts', () => {
    qc.invalidateQueries({ queryKey: ['alerts'] });
    qc.invalidateQueries({ queryKey: ['kpi'] });
  });

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand"><span className={`live-dot ${connected ? 'connected' : ''}`} />SENTINELSTREAM</span>
        <KpiStrip />
        <InjectorControls onViewRing={setRingCardId} />
        <button className="admin-toggle" onClick={() => setRingCardId('C-9001')}>View ring</button>
        <AdminIndexDrawer />
      </div>

      <div className="main">
        <div className="col">
          <TriageQueue
            selectedId={selectedAlertId}
            onSelect={setSelectedAlertId}
            onRaiseCase={() => setShowCreate(true)}
          />
          <SeverityTimelineChart />
        </div>
        <div className="col">
          <SettlementTape />
          <CategoryRiskChart />
          <TopCardsPanel onSelectCard={setRingCardId} />
        </div>
      </div>

      {selectedAlertId && (
        <AlertDetailDrawer
          alertId={selectedAlertId}
          onClose={() => setSelectedAlertId(null)}
          onViewRing={setRingCardId}
        />
      )}
      {showCreate && <CreateAlertModal onClose={() => setShowCreate(false)} />}
      {ringCardId && <RingPanel initialCardId={ringCardId} onClose={() => setRingCardId(null)} />}
    </div>
  );
}
