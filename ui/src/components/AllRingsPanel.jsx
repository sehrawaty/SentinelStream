import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';

// CLAUDE.md §4.4 ALL_RINGS -- the global sweep, distinct from RING_FOR_CARD
// (one seed card at a time). Powers spec §8's "cuttable all-rings panel":
// every device/IP currently shared by >= minFanout cards, ranked by fan-out
// size. Clicking a row opens the same RingPanel any other entry point does,
// seeded from that entity's first card -- RING_FOR_CARD from that card will
// naturally pull in the whole shared-entity subgraph ALL_RINGS just found.
export default function AllRingsPanel({ onSelectCard }) {
  const { data, isLoading } = useQuery({
    queryKey: ['allRings'],
    queryFn: () => api.allRings(3, 20),
    refetchInterval: 15000,
  });

  const rows = data ?? [];

  return (
    <div className="panel">
      <div className="panel-title">All rings — shared entities, Neo4j ALL_RINGS sweep</div>
      {isLoading && <div className="empty-state">Querying Neo4j…</div>}
      {!isLoading && rows.length === 0 && (
        <div className="empty-state">No shared entities yet. Inject a fraud ring to see detection live.</div>
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Entity</th>
                <th>Type</th>
                <th>Cards</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.entityId} onClick={() => onSelectCard?.(r.cardIds[0])}>
                  <td className="masked">{r.entityId}</td>
                  <td style={{ fontSize: 10, color: 'var(--text-mute)' }}>{r.entityType}</td>
                  <td className="tabular" style={{ color: r.cardCount >= 5 ? 'var(--critical)' : undefined }}>
                    {r.cardCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
