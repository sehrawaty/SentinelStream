import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';
import { api } from '../api.js';

// CLAUDE.md §6 -- the KPI $facet pipeline (D) already computes byRule; this
// panel just renders it. Same ['kpi'] query key as KpiStrip, so React Query
// dedupes the two into one poll rather than fetching the facet pipeline
// twice every 3s.
const RULE_COLOR = {
  VELOCITY: '#F2A03D',
  AMOUNT_ANOMALY: '#3FA7A0',
  IMPOSSIBLE_TRAVEL: '#E2574C',
  ENTITY_FANOUT: '#8B7FD4',
};

export default function RuleActivityChart() {
  const { data } = useQuery({
    queryKey: ['kpi'],
    queryFn: api.kpi,
    refetchInterval: 3000,
  });

  const rows = (data?.byRule ?? [])
    .map((r) => ({ rule: r._id, count: r.n, avgWeight: Math.round(r.avgWeight) }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="panel">
      <div className="panel-title">Rule Activity — fires by detector (60m)</div>
      {rows.length === 0 ? (
        <div className="empty-state">No alerts yet. Inject a fraud pattern to see detection live.</div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid stroke="var(--line)" horizontal={false} />
            <XAxis type="number" tick={{ fill: 'var(--text-mute)', fontSize: 10 }} stroke="var(--line)" allowDecimals={false} />
            <YAxis type="category" dataKey="rule" width={110} tick={{ fill: 'var(--text-mute)', fontSize: 9 }} stroke="var(--line)" />
            <Tooltip
              contentStyle={{ background: 'var(--panel-2)', border: '1px solid var(--line)', fontSize: 12 }}
              formatter={(v, name) => (name === 'count' ? [v, 'Fires'] : [v, name])}
              labelFormatter={(label, payload) => `${label} · weight ${payload?.[0]?.payload?.avgWeight ?? '—'}`}
            />
            <Bar dataKey="count" radius={[0, 2, 2, 0]}>
              {rows.map((r) => (
                <Cell key={r.rule} fill={RULE_COLOR[r.rule] ?? 'var(--text-mute)'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
