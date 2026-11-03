import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ANALYSTS } from './lib/format.js';
import { Icon, Modal } from './components/ui.jsx';

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

// Hash routing -- "#/triage", "#/rings/C-9001" -- so a view is linkable and the
// browser's back button works, without adding a router dependency.
function parseHash() {
  const [view = 'live', param = ''] = window.location.hash.replace(/^#\/?/, '').split('/');
  return { view: view || 'live', param: decodeURIComponent(param) };
}

export function AppProvider({ children }) {
  const [route, setRoute] = useState(parseHash);
  const [analyst, setAnalyst] = useState(ANALYSTS[0]);
  const [caseId, setCaseId] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [confirmState, setConfirmState] = useState(null);
  const nextToastId = useRef(1);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((view, param = '') => {
    window.location.hash = `/${view}${param ? `/${encodeURIComponent(param)}` : ''}`;
  }, []);

  const dismissToast = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  // toast({ title, body, tone: 'ok' | 'error' | 'info', action: { label, onClick }, key })
  // A toast with a key replaces the one already showing under that key, so a
  // burst of the same event (one ring injection resolves four rings) shows once.
  const toast = useCallback((t) => {
    const id = nextToastId.current++;
    setToasts((prev) => [...prev.filter((x) => !t.key || x.key !== t.key).slice(-2), { tone: 'ok', ...t, id }]);
    setTimeout(() => dismissToast(id), t.action ? 9000 : 4500);
  }, [dismissToast]);

  // confirm({ title, body, confirmLabel, danger, reasonLabel }) -> Promise<false | true | reason string>
  const confirm = useCallback((opts) => new Promise((resolve) => setConfirmState({ ...opts, resolve })), []);

  const value = { route, navigate, analyst, setAnalyst, caseId, openCase: setCaseId, closeCase: () => setCaseId(null), toast, confirm };

  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast tone-${t.tone}`}>
            <Icon name={t.tone === 'error' ? 'alert' : t.tone === 'info' ? 'zap' : 'check'} />
            <div className="toast-text">
              <strong>{t.title}</strong>
              {t.body && <span>{t.body}</span>}
            </div>
            {t.action && (
              <button className="btn small" onClick={() => { t.action.onClick(); dismissToast(t.id); }}>{t.action.label}</button>
            )}
            <button className="icon-btn" onClick={() => dismissToast(t.id)} aria-label="Dismiss"><Icon name="close" size={14} /></button>
          </div>
        ))}
      </div>
      {confirmState && <ConfirmDialog state={confirmState} onDone={() => setConfirmState(null)} />}
    </AppContext.Provider>
  );
}

function ConfirmDialog({ state, onDone }) {
  const [reason, setReason] = useState('');
  const finish = (result) => { state.resolve(result); onDone(); };
  const needsReason = !!state.reasonLabel;
  return (
    <Modal
      title={state.title}
      onClose={() => finish(false)}
      footer={(
        <>
          <button className="btn" onClick={() => finish(false)}>Cancel</button>
          <button
            className={`btn ${state.danger ? 'danger' : 'primary'}`}
            disabled={needsReason && !reason.trim()}
            onClick={() => finish(needsReason ? reason.trim() : true)}
          >
            {state.confirmLabel ?? 'Confirm'}
          </button>
        </>
      )}
    >
      {state.body && <p className="modal-text">{state.body}</p>}
      {needsReason && (
        <label className="field">
          <span>{state.reasonLabel}</span>
          <textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      )}
    </Modal>
  );
}
