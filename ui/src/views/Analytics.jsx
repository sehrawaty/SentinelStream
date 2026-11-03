import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api.js';
import { useApp } from '../app-context.jsx';
import { RULE_LABEL, count, money } from '../lib/format.js';
import { AXIS, GRID, INK, ORDINAL, SERIES, SEVERITY, SURFACE } from '../theme.js';
import { CardId, Empty, Icon, Panel, RuleChip, SkeletonRows } from '../components/ui.jsx';

const tick = { fill: INK.muted, fontSize: 11 };
const tooltip = {
  cursor: { fill: 'rgba(22,24,29,0.04)' },
  contentStyle: { background: SURFACE, border: `1px solid ${GRID}`, borderRadius: 8, fontSize: 12, boxShadow: '0 4px 14px rgba(22,24,29,0.08)' },
  labelStyle: { color: INK.primary, fontWeight: 600, marginBottom: 2 },
  itemStyle: { color: INK.secondary },
};

// A chart and its table twin behind one toggle: every value is readable
// without hovering and without relying on colour.
function ChartPanel({ title, subtitle, stages, loading, empty, columns, rows, children }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <Panel
      title={title}
      subtitle={subtitle}
      actions={rows.length > 0 && (
        <button className="btn small" onClick={() => setAsTable(!asTable)}>
          <Icon name={asTable ? 'chart' : 'table'} size={14} />{asTable ? 'Chart' : 'Table'}
        </button>
      )}
    >
      <p className="stages mono">{stages}</p>
      {loading && <SkeletonRows rows={5} />}
      {!loading && rows.length === 0 && <Empty title={empty} hint="Inject a fraud pattern from the live monitor." />}
      {!loading && rows.length > 0 && (asTable ? (
        <div className="table-wrap">
          <table>
            <thead><tr>{columns.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="static">
                  {columns.map((c) => <td key={c.key} className={c.num ? 'mono num' : ''}>{c.format ? c.format(r[c.key]) : r[c.key]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : children)}
    </Panel>
  );
}

function SeverityTimeline() {
  const { data, isLoading } = useQuery({ queryKey: ['severityTimeline'], queryFn: api.severityTimeline, refetchInterval: 10000 });
  const rows = (data ?? []).map((r) => ({
    time: new Date(r.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
    Low: r.bySeverity.LOW, Medium: r.bySeverity.MEDIUM, High: r.bySeverity.HIGH, total: r.total,
  }));
  return (
    <ChartPanel
      title="Alerts by severity" subtitle="Last 60 minutes, in 5 minute buckets" stages="alerts: $match → $group($dateTrunc) → $group → $sort"
      loading={isLoading} empty="No alerts in the last hour" rows={rows}
      columns={[{ key: 'time', label: 'From' }, { key: 'Low', label: 'Low', num: true }, { key: 'Medium', label: 'Medium', num: true }, { key: 'High', label: 'High', num: true }, { key: 'total', label: 'Total', num: true }]}
    >
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="time" tick={tick} stroke={AXIS} tickLine={false} />
          <YAxis tick={tick} stroke="transparent" allowDecimals={false} />
          <Tooltip {...tooltip} />
          <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12 }}
            formatter={(value) => <span style={{ color: INK.secondary }}>{value}</span>} />
          <Bar dataKey="Low" stackId="s" fill={SEVERITY.LOW} stroke={SURFACE} strokeWidth={2} />
          <Bar dataKey="Medium" stackId="s" fill={SEVERITY.MEDIUM} stroke={SURFACE} strokeWidth={2} />
          <Bar dataKey="High" stackId="s" fill={SEVERITY.HIGH} stroke={SURFACE} strokeWidth={2} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartPanel>
  );
}

function CategoryRisk() {
  const { data, isLoading } = useQuery({ queryKey: ['fraudByCategory'], queryFn: api.fraudByCategory, refetchInterval: 15000 });
  const rows = (data ?? []).map((r) => ({ ...r, pct: +(r.fraudRate * 100).toFixed(2) }));
  return (
    <ChartPanel
      title="Fraud rate by merchant category" subtitle="Share of transactions flagged, last 24 hours" stages="transactions: $match → $group → $match → $addFields → $sort"
      loading={isLoading} empty="No category has 20 transactions yet" rows={rows}
      columns={[{ key: 'category', label: 'Category' }, { key: 'pct', label: 'Flagged', num: true, format: (v) => `${v}%` }, { key: 'flagged', label: 'Flagged txns', num: true, format: count }, { key: 'total', label: 'All txns', num: true, format: count }, { key: 'avgTicket', label: 'Avg ticket', num: true, format: money }]}
    >
      <ResponsiveContainer width="100%" height={Math.max(220, rows.length * 26 + 30)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }} barCategoryGap="28%">
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" tick={tick} unit="%" stroke="transparent" />
          <YAxis type="category" dataKey="category" width={104} tick={tick} stroke={AXIS} tickLine={false} />
          <Tooltip {...tooltip} formatter={(v, _n, p) => [`${v}% (${count(p.payload.flagged)} of ${count(p.payload.total)})`, 'Flagged']} />
          <Bar dataKey="pct" fill={SERIES} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartPanel>
  );
}

function RuleActivity({ kpi, loading }) {
  const rows = (kpi?.byRule ?? []).map((r) => ({ rule: RULE_LABEL[r._id] ?? r._id, fires: r.n, weight: Math.round(r.avgWeight) }));
  return (
    <ChartPanel
      title="Detector activity" subtitle="How often each rule fired, last 60 minutes" stages="alerts: $match → $facet { $unwind rules → $group → $sort }"
      loading={loading} empty="No detector has fired in the last hour" rows={rows}
      columns={[{ key: 'rule', label: 'Rule' }, { key: 'fires', label: 'Fires', num: true, format: count }, { key: 'weight', label: 'Weight', num: true }]}
    >
      <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 38 + 30)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }} barCategoryGap="30%">
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" tick={tick} stroke="transparent" allowDecimals={false} />
          <YAxis type="category" dataKey="rule" width={124} tick={tick} stroke={AXIS} tickLine={false} />
          <Tooltip {...tooltip} formatter={(v, _n, p) => [`${count(v)} (weight ${p.payload.weight})`, 'Fires']} />
          <Bar dataKey="fires" fill={SERIES} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartPanel>
  );
}

const BANDS = { 0: '1 to 39', 40: '40 to 69', 70: '70 to 89', 90: '90 to 100' };

function ScoreBands({ kpi, loading }) {
  const found = Object.fromEntries((kpi?.scoreBands ?? []).map((b) => [b._id, b.n]));
  const any = (kpi?.scoreBands ?? []).length > 0;
  const rows = any ? Object.entries(BANDS).map(([floor, band]) => ({ band, alerts: found[floor] ?? 0 })) : [];
  return (
    <ChartPanel
      title="Alerts by score band" subtitle="Low is under 40, medium under 70, high from 70" stages="alerts: $match → $facet { $bucket by score }"
      loading={loading} empty="No alerts in the last hour" rows={rows}
      columns={[{ key: 'band', label: 'Score' }, { key: 'alerts', label: 'Alerts', num: true, format: count }]}
    >
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }} barCategoryGap="30%">
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="band" tick={tick} stroke={AXIS} tickLine={false} />
          <YAxis tick={tick} stroke="transparent" allowDecimals={false} />
          <Tooltip {...tooltip} formatter={(v) => [count(v), 'Alerts']} />
          <Bar dataKey="alerts" radius={[4, 4, 0, 0]}>
            {rows.map((r, i) => <Cell key={r.band} fill={ORDINAL[i]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartPanel>
  );
}

function Watchlist() {
  const { navigate } = useApp();
  const { data, isLoading } = useQuery({ queryKey: ['topCards'], queryFn: api.topCards, refetchInterval: 15000 });
  const rows = data ?? [];
  return (
    <Panel title="Watchlist" subtitle="Cards with the most alerts, last 24 hours" flush className="span-2">
      <p className="stages mono padded">alerts: $match → $group by cardId → $reduce($setUnion) → $sort → $limit</p>
      {isLoading && <SkeletonRows rows={5} />}
      {!isLoading && rows.length === 0 && <Empty title="No alerts in the last 24 hours" hint="Inject a fraud pattern from the live monitor." />}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Card</th><th className="num">Alerts</th><th className="num">High</th><th className="num">Top score</th><th>Rules</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.cardId} className="static">
                  <td><CardId id={c.cardId} blocked={c.blocked} /></td>
                  <td className="mono num">{c.alerts}</td>
                  <td className="mono num">{c.high}</td>
                  <td className="mono num">{c.maxScore}</td>
                  <td><span className="chips">{c.rules.map((r) => <RuleChip key={r} type={r} />)}</span></td>
                  <td className="row-actions end">
                    <button className="link" onClick={() => navigate('triage', c.cardId)}>Alerts</button>
                    <button className="link" onClick={() => navigate('rings', c.cardId)}>Ring</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export default function Analytics() {
  const { data: kpi, isLoading } = useQuery({ queryKey: ['kpi'], queryFn: api.kpi, refetchInterval: 3000 });
  return (
    <div className="analytics-grid">
      <SeverityTimeline />
      <CategoryRisk />
      <RuleActivity kpi={kpi} loading={isLoading} />
      <ScoreBands kpi={kpi} loading={isLoading} />
      <Watchlist />
    </div>
  );
}
