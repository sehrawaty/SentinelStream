import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { api } from '../api.js';

cytoscape.use(fcose);

// CLAUDE.md §4.4 -- renders RING_FOR_CARD's shared-entity subgraph. Card
// nodes are round, entity nodes (Device/Ip) are square; a blocked card and
// a card that is the seed itself get distinct outlines so the shape of the
// ring (who shares what with whom) reads at a glance, not just the list.
function buildElements(ring, seedCardId) {
  if (!ring) return [];
  const cardEls = ring.cardNodes.map((c) => ({
    data: { id: `card:${c.id}`, label: c.id, kind: 'card', blocked: !!c.blocked, seed: c.id === seedCardId },
  }));
  const entityEls = ring.entityNodes.map((e) => ({
    data: { id: `entity:${e.id}`, label: e.id, kind: 'entity', entityType: e.type },
  }));
  const edgeEls = ring.edges.map((e, i) => ({
    data: {
      id: `edge:${i}`,
      source: `card:${e.from}`,
      target: `entity:${e.to}`,
      label: `${e.rel === 'USED_DEVICE' ? 'device' : 'ip'} ×${e.weight ?? 1}`,
    },
  }));
  return [...cardEls, ...entityEls, ...edgeEls];
}

const STYLE = [
  {
    selector: 'node[kind = "card"]',
    style: {
      shape: 'ellipse',
      'background-color': '#3FA7A0',
      label: 'data(label)',
      color: '#E4EBF0',
      'font-size': 9,
      'font-family': 'IBM Plex Mono, monospace',
      'text-valign': 'bottom',
      'text-margin-y': 4,
      width: 28,
      height: 28,
      'border-width': 0,
    },
  },
  {
    selector: 'node[kind = "card"][?seed]',
    style: { 'border-width': 3, 'border-color': '#F2A03D', width: 34, height: 34 },
  },
  {
    selector: 'node[kind = "card"][?blocked]',
    style: { 'background-color': '#E2574C' },
  },
  {
    selector: 'node[kind = "entity"]',
    style: {
      shape: 'round-rectangle',
      'background-color': '#8B7FD4',
      label: 'data(label)',
      color: '#E4EBF0',
      'font-size': 9,
      'font-family': 'IBM Plex Mono, monospace',
      'text-valign': 'bottom',
      'text-margin-y': 4,
      width: 22,
      height: 22,
    },
  },
  {
    selector: 'node[entityType = "Ip"]',
    style: { 'background-color': '#6B6094' },
  },
  {
    selector: 'edge',
    style: {
      width: 1.5,
      'line-color': '#22303C',
      'curve-style': 'bezier',
      label: 'data(label)',
      'font-size': 7,
      color: '#9FB0BD',
      'font-family': 'IBM Plex Mono, monospace',
      'text-background-color': '#141E27',
      'text-background-opacity': 0.85,
      'text-background-padding': 1,
    },
  },
];

function RingGraph({ ring, seedCardId }) {
  const containerRef = useRef(null);
  const cyRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      style: STYLE,
      elements: buildElements(ring, seedCardId),
      wheelSensitivity: 0.25,
    });
    cy.layout({ name: 'fcose', animate: false, nodeSeparation: 90, idealEdgeLength: 90 }).run();
    cyRef.current = cy;
    return () => cy.destroy();
  }, [ring, seedCardId]);

  return <div ref={containerRef} className="ring-graph" />;
}

export default function RingPanel({ initialCardId, onClose }) {
  const [cardId, setCardId] = useState(initialCardId || '');
  const [queryCardId, setQueryCardId] = useState(initialCardId || '');

  useEffect(() => {
    if (initialCardId) {
      setCardId(initialCardId);
      setQueryCardId(initialCardId);
    }
  }, [initialCardId]);

  const { data: ring, isLoading, isFetching, error } = useQuery({
    queryKey: ['ringForCard', queryCardId],
    queryFn: () => api.ringForCard(queryCardId),
    enabled: !!queryCardId,
  });

  const submit = (e) => {
    e.preventDefault();
    if (cardId.trim()) setQueryCardId(cardId.trim());
  };

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer" style={{ width: 'min(760px, 95vw)' }}>
        <div className="drawer-header">
          <div>
            <h3>Entity ring — Neo4j RING_FOR_CARD</h3>
            <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 4 }}>
              Shared devices/IPs within 6 hops (CLAUDE.md §4.4). Prefer{' '}
              <code>C-9001</code> for the clean seeded demo ring (§8 D-31).
            </div>
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form onSubmit={submit} style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <input
            style={{ flex: 1, background: 'var(--panel-2)', border: '1px solid var(--line)', color: 'var(--text)', padding: 6, borderRadius: 3, fontFamily: 'var(--font-mono)' }}
            value={cardId}
            onChange={(e) => setCardId(e.target.value)}
            placeholder="C-9001"
          />
          <button className="btn primary" type="submit" disabled={!cardId.trim()}>
            {isFetching ? 'Querying…' : 'View ring'}
          </button>
        </form>

        {!queryCardId && <div className="empty-state">Enter a card id to run RING_FOR_CARD.</div>}
        {queryCardId && isLoading && <div className="empty-state">Querying Neo4j…</div>}
        {error && <div style={{ color: 'var(--critical)', fontSize: 12 }}>{error.message}</div>}

        {ring && !ring.found && (
          <div className="empty-state">
            No shared entities found for <span className="masked">{queryCardId}</span> — either an
            isolated card, or below the size≥2 shared-entity threshold.
          </div>
        )}

        {ring && ring.found && (
          <>
            <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-mute)', margin: '4px 0 10px' }}>
              <span><b style={{ color: 'var(--text)' }}>{ring.cardNodes.length}</b> cards</span>
              <span><b style={{ color: 'var(--text)' }}>{ring.entityNodes.length}</b> shared entities</span>
              <span><b style={{ color: 'var(--text)' }}>{ring.queryMs}</b>ms query</span>
            </div>
            <RingGraph ring={ring} seedCardId={queryCardId} />
            <div style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--text-mute)', marginTop: 8 }}>
              <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#3FA7A0', marginRight: 4 }} />card</span>
              <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#E2574C', marginRight: 4 }} />blocked card</span>
              <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#8B7FD4', marginRight: 4 }} />device</span>
              <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#6B6094', marginRight: 4 }} />ip</span>
              <span><span style={{ display: 'inline-block', width: 8, height: 8, border: '2px solid #F2A03D', marginRight: 4 }} />seed</span>
            </div>
          </>
        )}
      </div>
    </>
  );
}
