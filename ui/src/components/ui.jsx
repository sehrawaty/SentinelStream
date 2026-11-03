import { useEffect } from 'react';
import { RULE_LABEL, STATUS_LABEL } from '../lib/format.js';

// Stroke icons on a 24px grid, drawn inline so no icon package is needed.
const PATHS = {
  live: 'M3 12h4l3-8 4 16 3-8h4',
  triage: 'M4 5h16M4 12h10M4 19h6M17 14l4 4-4 4',
  rings: 'M6 6a2 2 0 100-4 2 2 0 000 4zM18 9a2 2 0 100-4 2 2 0 000 4zM12 22a2 2 0 100-4 2 2 0 000 4zM7.6 5l8.6 1.6M7 5.8l4.2 12.4M17 8.8l-4 9.4',
  chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 4l13 8-13 8z',
  close: 'M6 6l12 12M18 6L6 18',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  shield: 'M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  zap: 'M13 2L4 14h7l-1 8 9-12h-7z',
  plane: 'M2 13l20-8-8 17-3-7z',
  check: 'M5 12l5 5L20 7',
  alert: 'M12 4l10 17H2zM12 10v5M12 18v.5',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  table: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v14',
};

export function Icon({ name, size = 16 }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Panel({ title, subtitle, actions, flush, className = '', children }) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="panel-sub">{subtitle}</p>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className={flush ? 'panel-body flush' : 'panel-body'}>{children}</div>
    </section>
  );
}

export const SeverityPill = ({ value }) => <span className={`pill sev-${value}`}>{value}</span>;
export const StatusPill = ({ value }) => <span className={`pill status-${value}`}>{STATUS_LABEL[value] ?? value}</span>;
export const RuleChip = ({ type }) => <span className="chip">{RULE_LABEL[type] ?? type}</span>;
export const CardId = ({ id, blocked }) => (
  <span className="mono card-id">{id}{blocked && <span className="blocked-tag">Blocked</span>}</span>
);

export function Empty({ title, hint, action }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
      {action}
    </div>
  );
}

export function SkeletonRows({ rows = 5 }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => <span key={i} style={{ width: `${92 - (i % 3) * 14}%` }} />)}
    </div>
  );
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return <div className="error-note" role="alert"><Icon name="alert" />{error.message ?? String(error)}</div>;
}

function useEscape(onClose) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

export function Modal({ title, onClose, children, footer, width = 440 }) {
  useEscape(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, width = 560 }) {
  useEscape(onClose);
  return (
    <div className="overlay drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
        {children}
      </aside>
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Segmented({ value, onChange, options }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value}
          className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
