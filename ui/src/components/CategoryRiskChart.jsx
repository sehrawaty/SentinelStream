import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api } from '../api.js';

// Pipeline A (implementation plan Part 3) -- fraud rate by merchant category.
export default function CategoryRiskChart() {
  const { data } = useQuery({
    queryKey: ['fraudByCategory'],
    queryFn: api.fraudByCategory,
    refetchInterval: 15000,
  });

  const rows = (data ?? []).map((r) => ({ ...r, fraudPct: +(r.fraudRate * 100).toFixed(2) }));

  return (
    <div className="panel">
      <div className="panel-title">Category Risk — fraud rate by merchant category</div>
      {rows.length === 0 ? (
        <div className="empty-state">Not enough volume yet in any category (min 20 transactions).</div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid stroke="var(--line)" horizontal={false} />
            <XAxis type="number" tick={{ fill: 'var(--text-mute)', fontSize: 10 }} unit="%" stroke="var(--line)" />
            <YAxis type="category" dataKey="category" width={90} tick={{ fill: 'var(--text-mute)', fontSize: 10 }} stroke="var(--line)" />
            <Tooltip
              contentStyle={{ background: 'var(--panel-2)', border: '1px solid var(--line)', fontSize: 12 }}
              formatter={(v, name) => (name === 'fraudPct' ? [`${v}%`, 'Fraud rate'] : [v, name])}
            />
            <Bar dataKey="fraudPct" fill="var(--signal)" radius={[0, 2, 2, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
