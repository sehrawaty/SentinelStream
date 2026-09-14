import { useState } from 'react';
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

export default function App() {
  const [selectedAlertId, setSelectedAlertId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [ringCardId, setRingCardId] = useState(null);

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand"><span className="live-dot" />SENTINELSTREAM</span>
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
