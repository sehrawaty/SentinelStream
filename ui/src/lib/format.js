export const ANALYSTS = ['analyst.yash', 'analyst.dev', 'system'];

export const STATUS_LABEL = {
  NEW: 'New',
  INVESTIGATING: 'Investigating',
  CONFIRMED_FRAUD: 'Confirmed fraud',
  FALSE_POSITIVE: 'False positive',
};

export const RULE_LABEL = {
  VELOCITY: 'Velocity',
  AMOUNT_ANOMALY: 'Amount anomaly',
  IMPOSSIBLE_TRAVEL: 'Impossible travel',
  ENTITY_FANOUT: 'Entity fan-out',
  MANUAL_REVIEW: 'Manual review',
};

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('en-IN');

export const money = (v) => (v == null || v === '' ? '—' : inr.format(Number(v)));
export const count = (v) => (v == null ? '—' : num.format(v));

export function timeAgo(iso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });
export const dateTime = (ts) =>
  new Date(ts).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

// One plain-English sentence per fired rule, built from that rule's own
// evidence fields. Evidence has no fixed shape (CLAUDE.md §4.2), so an unknown
// rule simply gets no sentence and falls back to the raw field grid.
export function explainRule(rule) {
  const e = rule.evidence ?? {};
  switch (rule.type) {
    case 'VELOCITY':
      return `${e.count} transactions in ${e.windowSec}s. The limit is ${e.threshold}.`;
    case 'AMOUNT_ANOMALY':
      return `${money(e.amount)} against a usual ${money(e.mean)} (±${money(e.stddev)}). Anything over ${money(e.threshold)} is ${e.sigma}σ out.`;
    case 'IMPOSSIBLE_TRAVEL':
      return `${e.fromCity} to ${e.toCity}: ${count(e.km)} km in ${e.seconds}s, an implied ${count(Math.round(e.impliedKmh))} km/h. The limit is ${e.threshold} km/h.`;
    case 'ENTITY_FANOUT': {
      const parts = [];
      if (e.deviceId) parts.push(`device ${e.deviceId} used by ${e.deviceCardCount} cards`);
      if (e.ip) parts.push(`IP ${e.ip} used by ${e.ipCardCount} cards`);
      return `${parts.join('; ')} within ${Math.round(e.windowSec / 60)} min. The limit is ${e.threshold}.`;
    }
    case 'MANUAL_REVIEW':
      return e.reason ?? null;
    default:
      return null;
  }
}
