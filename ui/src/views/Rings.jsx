import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { useApp } from '../app-context.jsx';
import { timeAgo } from '../lib/format.js';
import { Empty, ErrorNote, Icon, Panel, SkeletonRows } from '../components/ui.jsx';
import RingGraph from '../components/RingGraph.jsx';

const SEEDED = 'C-9001'; // the isolated demo ring seed.mjs writes (CLAUDE.md §8 D-31)

const CYPHER = `MATCH (seed:Card {cardId: $cardId})
CALL {
  WITH seed
  MATCH (seed)-[:USED_DEVICE|FROM_IP*1..6]-(m:Card)
  WHERE m <> seed
  RETURN collect(DISTINCT m) AS others
}
WITH [seed] + others AS cards
UNWIND cards AS c
MATCH (c)-[r:USED_DEVICE|FROM_IP]->(e)
WITH cards, c, r, e
WHERE size([ (x:Card)-[:USED_DEVICE|FROM_IP]->(e)
             WHERE x IN cards | x ]) >= 2
RETURN
  [x IN cards | { id: x.cardId, blocked: coalesce(x.blocked, false) }] AS cardNodes,
  collect(DISTINCT { id: coalesce(e.deviceId, e.ip),
                     type: head(labels(e)) })                          AS entityNodes,
  collect(DISTINCT { from: c.cardId, to: coalesce(e.deviceId, e.ip),
                     rel: type(r), weight: r.count })                  AS edges`;

const KIND_LABEL = { card: 'Card', device: 'Device', ip: 'IP address' };

function NodeDetails({ node, onRecentre }) {
  const { analyst, navigate, toast, confirm } = useApp();
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['ring'] }); qc.invalidateQueries({ queryKey: ['blocked'] }); };

  const block = useMutation({
    mutationFn: () => api.blockCard(node.entityId, { reason: 'Blocked from the ring graph', by: analyst, sourceAlertId: null }),
    onSuccess: () => { refresh(); toast({ title: `${node.entityId} blocked` }); },
    onError: (e) => toast({ tone: 'error', title: 'Block failed', body: e.message }),
  });
  const unblock = useMutation({
    mutationFn: () => api.unblockCard(node.entityId, analyst),
    onSuccess: () => { refresh(); toast({ title: `${node.entityId} unblocked` }); },
    onError: (e) => toast({ tone: 'error', title: 'Unblock failed', body: e.message }),
  });

  const askBlock = async () => {
    if (await confirm({ title: `Block card ${node.entityId}?`, body: 'Its next transactions are declined at the stream.', confirmLabel: 'Block card', danger: true })) {
      block.mutate();
    }
  };

  const isCard = node.kind === 'card';
  return (
    <Panel title={KIND_LABEL[node.kind]} subtitle={isCard ? `Uses ${node.neighbours.length} shared devices or IPs` : `Shared by ${node.neighbours.length} cards`}>
      <p className="mono node-id">{node.entityId}{node.blocked && <span className="pill sev-HIGH">Blocked</span>}</p>
      <ul className="neighbours">
        {node.neighbours.map((n) => <li key={n.id} className="mono"><span className={`swatch kind-${n.kind}`} />{n.id}</li>)}
      </ul>
      {isCard && (
        <div className="row-actions">
          <button className="btn small" onClick={() => navigate('triage', node.entityId)}>See its alerts</button>
          {!node.seed && <button className="btn small" onClick={() => onRecentre(node.entityId)}>Centre here</button>}
          {node.blocked
            ? <button className="btn small" disabled={unblock.isPending} onClick={() => unblock.mutate()}>Unblock</button>
            : <button className="btn small danger" disabled={block.isPending} onClick={askBlock}>Block card</button>}
        </div>
      )}
    </Panel>
  );
}

export default function Rings({ param }) {
  const { navigate } = useApp();
  const cardId = param || SEEDED;
  const [input, setInput] = useState(cardId);
  const [selected, setSelected] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showQuery, setShowQuery] = useState(false);

  useEffect(() => { setInput(cardId); setSelected(null); }, [cardId]);
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (e) => e.key === 'Escape' && setFullscreen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const go = (id) => navigate('rings', id.trim());

  const { data: ring, isLoading, isFetching, error } = useQuery({
    queryKey: ['ring', cardId], queryFn: () => api.ringForCard(cardId),
  });
  // A refetch that changed the ring (a block, a new member) rebuilds the graph,
  // so whatever was selected in the old one no longer exists.
  useEffect(() => setSelected(null), [ring]);
  const { data: snapshots, isLoading: loadingSnapshots } = useQuery({
    queryKey: ['ringSnapshots'], queryFn: api.ringSnapshots, refetchInterval: 15000,
  });
  const { data: shared, isLoading: loadingShared } = useQuery({
    queryKey: ['allRings'], queryFn: () => api.allRings(3, 12), refetchInterval: 15000,
  });

  return (
    <div className="rings-grid">
      <Panel
        className={fullscreen ? 'ring-panel fullscreen' : 'ring-panel'}
        title="Ring for a card"
        subtitle="One Neo4j traversal, up to six hops, keeping only devices and IPs shared by two or more cards"
        flush
        actions={(
          <>
            <button className="btn small" onClick={() => setShowQuery(!showQuery)}><Icon name="code" size={14} />{showQuery ? 'Hide Cypher' : 'Show Cypher'}</button>
            <button className="btn small" onClick={() => setFullscreen(!fullscreen)}><Icon name="expand" size={14} />{fullscreen ? 'Exit full screen' : 'Full screen'}</button>
          </>
        )}
      >
        <form className="toolbar" onSubmit={(e) => { e.preventDefault(); if (input.trim()) go(input); }}>
          <div className="search grow">
            <Icon name="search" size={14} />
            <input className="mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Card id" aria-label="Card id" />
          </div>
          <button className="btn primary" type="submit" disabled={!input.trim()}>{isFetching ? 'Querying' : 'Find ring'}</button>
          {cardId !== SEEDED && <button className="btn" type="button" onClick={() => go(SEEDED)}>Seeded demo ring</button>}
          {ring?.found && (
            <div className="ring-stats">
              <span><strong>{ring.cardNodes.length}</strong> cards</span>
              <span><strong>{ring.entityNodes.length}</strong> shared</span>
              <span><strong>{ring.queryMs}</strong> ms</span>
            </div>
          )}
        </form>

        {showQuery && <pre className="cypher">{CYPHER}</pre>}
        <ErrorNote error={error} />

        <div className="ring-stage">
          {isLoading && <SkeletonRows rows={6} />}
          {ring && !ring.found && (
            <Empty
              title={`No ring found for ${cardId}`}
              hint="The card is unknown to the graph, or shares no device or IP with another card."
              action={<button className="btn" onClick={() => go(SEEDED)}>Open the seeded demo ring</button>}
            />
          )}
          {ring?.found && <RingGraph ring={ring} seedCardId={cardId} onSelect={setSelected} />}
        </div>

        {ring?.found && (
          <div className="legend">
            <span><span className="swatch kind-card" />Card</span>
            <span><span className="swatch kind-device" />Device</span>
            <span><span className="swatch kind-ip" />IP address</span>
            <span><span className="swatch kind-blocked" />Blocked card</span>
            <span><span className="swatch kind-seed" />Searched card</span>
            <span className="muted">Hover to isolate a node, click for details, scroll to zoom.</span>
          </div>
        )}
      </Panel>

      <div className="stack">
        {selected && <NodeDetails node={selected} onRecentre={go} />}

        <Panel title="Detected rings" subtitle="Saved when fan-out fired in Redis and Neo4j resolved the group" flush>
          {loadingSnapshots && <SkeletonRows rows={3} />}
          {!loadingSnapshots && (snapshots ?? []).length === 0 && (
            <Empty title="No rings detected yet" hint="Inject a fraud ring from the live monitor." />
          )}
          <ul className="rows">
            {(snapshots ?? []).map((s) => (
              <li key={s.ringId}>
                <button className={s.seedCardId === cardId ? 'row-btn active' : 'row-btn'} onClick={() => go(s.seedCardId)}>
                  <span className="mono">{s.ringId}</span>
                  <span>{s.cardIds.length} cards · {s.sharedEntities.length} shared</span>
                  <span className="muted">{timeAgo(s.discoveredAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Most shared devices and IPs" subtitle="Whole-graph sweep for anything used by three or more cards" flush>
          {loadingShared && <SkeletonRows rows={3} />}
          {!loadingShared && (shared ?? []).length === 0 && (
            <Empty title="Nothing is shared by three cards" hint="Inject a fraud ring from the live monitor." />
          )}
          <ul className="rows">
            {(shared ?? []).map((r) => (
              <li key={r.entityId}>
                <button className="row-btn" onClick={() => go(r.cardIds[0])}>
                  <span className="mono"><span className={`swatch kind-${r.entityType === 'Ip' ? 'ip' : 'device'}`} />{r.entityId}</span>
                  <span>{r.cardCount} cards</span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
