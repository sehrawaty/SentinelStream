// Thin fetch wrapper. Vite dev proxies /api to localhost:8080 (vite.config.js);
// the production nginx image reverse-proxies the same path to the api
// container (ui/nginx.conf) -- so this file never needs an absolute origin.

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.error || body.message || JSON.stringify(body);
    } catch {
      detail = res.statusText;
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  // stats
  kpi: () => request('/api/stats/kpi?minutes=60'),
  fraudByCategory: () => request('/api/stats/fraud-by-category?hours=24'),
  severityTimeline: () => request('/api/stats/severity-timeline?minutes=60&binSize=5'),
  topCards: () => request('/api/stats/top-cards?limit=8&hours=24'),

  // alerts
  listAlerts: (params) => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v)));
    return request(`/api/alerts?${qs.toString()}`);
  },
  alertDetail: (alertId) => request(`/api/alerts/${alertId}`),
  createManual: (body) => request('/api/alerts/manual', { method: 'POST', body: JSON.stringify(body) }),
  changeStatus: (alertId, body) => request(`/api/alerts/${alertId}/status`, { method: 'PATCH', body: JSON.stringify(body) }),
  addNote: (alertId, body) => request(`/api/alerts/${alertId}/notes`, { method: 'POST', body: JSON.stringify(body) }),
  editNote: (alertId, noteId, body) => request(`/api/alerts/${alertId}/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteNote: (alertId, noteId) => request(`/api/alerts/${alertId}/notes/${noteId}`, { method: 'DELETE' }),
  dismiss: (alertId, reason, by) => request(`/api/alerts/${alertId}?${new URLSearchParams({ reason, by })}`, { method: 'DELETE' }),

  // cards
  blockCard: (cardId, body) => request(`/api/cards/${cardId}/block`, { method: 'POST', body: JSON.stringify(body) }),
  unblockCard: (cardId, by) => request(`/api/cards/${cardId}/block?${new URLSearchParams({ by })}`, { method: 'DELETE' }),

  // control
  injectVelocity: () => request('/api/control/inject/velocity', { method: 'POST' }),
  injectTravel: () => request('/api/control/inject/travel', { method: 'POST' }),
  injectRing: () => request('/api/control/inject/ring', { method: 'POST' }),

  // admin
  indexes: () => request('/api/admin/indexes'),
  mongoStats: () => request('/api/admin/mongo-stats'),
  health: () => request('/api/health'),
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
