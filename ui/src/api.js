// Thin fetch wrapper. Both `vite` and `vite preview` proxy /api to the API
// (vite.config.js), so this file never needs an absolute origin.

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.detail || body.error || body.message || JSON.stringify(body);
    } catch {
      detail = res.statusText;
    }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const post = (path, body) => request(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
const patch = (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = (path) => request(path, { method: 'DELETE' });
const qs = (params) =>
  new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null))).toString();

export const api = {
  // stats -- aggregation pipelines A-D, plus the Redis-backed ingest rate
  kpi: () => request('/api/stats/kpi?minutes=60'),
  throughput: () => request('/api/stats/throughput'),
  fraudByCategory: () => request('/api/stats/fraud-by-category?hours=24'),
  severityTimeline: () => request('/api/stats/severity-timeline?minutes=60&binSize=5'),
  topCards: () => request('/api/stats/top-cards?limit=8&hours=24'),

  // alerts
  listAlerts: (params) => request(`/api/alerts?${qs(params)}`),
  explainQueue: (params) => request(`/api/alerts/explain?${qs(params)}`),
  alertDetail: (alertId) => request(`/api/alerts/${alertId}`),
  createManual: (body) => post('/api/alerts/manual', body),
  changeStatus: (alertId, body) => patch(`/api/alerts/${alertId}/status`, body),
  assign: (alertId, assignee) => patch(`/api/alerts/${alertId}/assign`, { assignee }),
  addNote: (alertId, body) => post(`/api/alerts/${alertId}/notes`, body),
  editNote: (alertId, noteId, body) => patch(`/api/alerts/${alertId}/notes/${noteId}`, body),
  deleteNote: (alertId, noteId) => del(`/api/alerts/${alertId}/notes/${noteId}`),
  dismiss: (alertId, reason, by) => del(`/api/alerts/${alertId}?${qs({ reason, by })}`),
  bulkDismiss: (status, by) => del(`/api/alerts?${qs({ status, by })}`),

  // cards and transactions
  blockedCards: () => request('/api/cards/blocked'),
  blockCard: (cardId, body) => post(`/api/cards/${cardId}/block`, body),
  unblockCard: (cardId, by) => del(`/api/cards/${cardId}/block?${qs({ by })}`),
  txns: (cardId, limit = 15) => request(`/api/txns?${qs({ cardId, limit })}`),

  // control
  injectVelocity: () => post('/api/control/inject/velocity'),
  injectAmount: () => post('/api/control/inject/amount'),
  injectTravel: () => post('/api/control/inject/travel'),
  injectRing: () => post('/api/control/inject/ring'),
  generatorStatus: () => request('/api/control/generator/status'),
  generatorPause: () => post('/api/control/generator/pause'),
  generatorResume: () => post('/api/control/generator/resume'),

  // admin
  // 503 carries the same per-store body as 200, so it is read rather than thrown.
  health: () => fetch('/api/health').then((r) => r.json()),
  indexes: () => request('/api/admin/indexes'),
  mongoStats: () => request('/api/admin/mongo-stats'),
  redisStats: () => request('/api/admin/redis-stats'),
  neo4jStats: () => request('/api/admin/neo4j-stats'),

  // rings -- CLAUDE.md §4.4
  ringForCard: (cardId) => request(`/api/rings/${encodeURIComponent(cardId)}`),
  ringSnapshots: () => request('/api/rings/snapshots?limit=12'),
  allRings: (minFanout = 3, limit = 20) => request(`/api/rings?${qs({ minFanout, limit })}`),
};

// CLAUDE.md §4.5 -- mirrors AlertStatus.java's legal-transition map so the UI
// only ever offers a button for a move the server will actually accept.
export const LEGAL_TRANSITIONS = {
  NEW: ['INVESTIGATING'],
  INVESTIGATING: ['CONFIRMED_FRAUD', 'FALSE_POSITIVE'],
  CONFIRMED_FRAUD: ['INVESTIGATING'],
  FALSE_POSITIVE: ['INVESTIGATING'],
};

export const DELETE_ELIGIBLE = new Set(['NEW', 'FALSE_POSITIVE']);
export const RESOLUTION_REQUIRED = new Set(['CONFIRMED_FRAUD', 'FALSE_POSITIVE']);
