import { useQuery } from '@tanstack/react-query';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api } from '../api.js';

// Pipeline B (implementation plan Part 3) -- severity distribution bucketed
// by minute, zero-filled so a quiet minute is a zero, not a gap.
export default function SeverityTimelineChart() {
  const { data } = useQuery({
    queryKey: ['severityTimeline'],
    queryFn: api.severityTimeline,
    refetchInterval: 10000,
  });

  const rows = (data ?? []).map((r) => ({
    time: new Date(r.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    LOW: r.bySeverity.LOW, MEDIUM: r.bySeverity.MEDIUM, HIGH: r.bySeverity.HIGH,
  }));

  return (
    <div className="panel">
      <div className="panel-title">Rule Activity — severity over the last hour</div>
      {rows.length === 0 ? (
        <div className="empty-state">No alerts yet. Inject a fraud pattern to see detection live.</div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={rows} margin={{ left: -20 }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis dataKey="time" tick={{ fill: 'var(--text-mute)', fontSize: 10 }} stroke="var(--line)" />
            <YAxis tick={{ fill: 'var(--text-mute)', fontSize: 10 }} stroke="var(--line)" allowDecimals={false} />
            <Tooltip contentStyle={{ background: 'var(--panel-2)', border: '1px solid var(--line)', fontSize: 12 }} />
            <Area type="monotone" dataKey="LOW" stackId="1" stroke="var(--calm)" fill="var(--calm)" fillOpacity={0.5} />
            <Area type="monotone" dataKey="MEDIUM" stackId="1" stroke="var(--signal)" fill="var(--signal)" fillOpacity={0.5} />
            <Area type="monotone" dataKey="HIGH" stackId="1" stroke="var(--critical)" fill="var(--critical)" fillOpacity={0.6} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
