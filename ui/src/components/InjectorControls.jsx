import { useState } from 'react';
import { api } from '../api.js';

// Spec §5 injectable patterns, wired to the buttons the demo script (§9) drives.
export default function InjectorControls() {
  const [busy, setBusy] = useState(null);
  const [lastResult, setLastResult] = useState(null);

  const fire = async (name, fn) => {
    setBusy(name);
    setLastResult(null);
    try {
      const result = await fn();
      setLastResult({ name, ok: true, detail: JSON.stringify(result) });
    } catch (e) {
      setLastResult({ name, ok: false, detail: e.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="topbar-actions" style={{ alignItems: 'center' }}>
      {lastResult && (
        <span style={{ fontSize: 10, color: lastResult.ok ? 'var(--calm)' : 'var(--critical)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {lastResult.name}: {lastResult.detail}
        </span>
      )}
      <button className="btn" disabled={!!busy} onClick={() => fire('velocity', api.injectVelocity)}>
        {busy === 'velocity' ? 'Injecting…' : 'Inject velocity'}
      </button>
      <button className="btn" disabled={!!busy} onClick={() => fire('travel', api.injectTravel)}>
        {busy === 'travel' ? 'Injecting…' : 'Inject travel'}
      </button>
      <button className="btn danger" disabled={!!busy} onClick={() => fire('ring', api.injectRing)}>
        {busy === 'ring' ? 'Injecting…' : 'Inject ring'}
      </button>
    </div>
  );
}
