import { useEffect, useRef } from 'react';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { GRAPH, INK, SURFACE } from '../theme.js';

cytoscape.use(fcose);

// CLAUDE.md §4.4 -- RING_FOR_CARD's shared-entity subgraph. Shape carries the
// node kind as well as colour (card: circle, device: square, IP: diamond), so
// the graph still reads without colour vision.
function buildElements(ring, seedCardId) {
  const cards = ring.cardNodes.map((c) => ({
    data: { id: `card:${c.id}`, label: c.id, kind: 'card', entityId: c.id, blocked: !!c.blocked, seed: c.id === seedCardId },
  }));
  const entities = ring.entityNodes.map((e) => ({
    data: { id: `entity:${e.id}`, label: e.id, kind: e.type === 'Ip' ? 'ip' : 'device', entityId: e.id },
  }));
  const edges = ring.edges.map((e, i) => ({
    data: { id: `edge:${i}`, source: `card:${e.from}`, target: `entity:${e.to}`, weight: e.weight ?? 1 },
  }));
  return [...cards, ...entities, ...edges];
}

const label = {
  label: 'data(label)',
  color: INK.secondary,
  'font-size': 10,
  'font-family': 'IBM Plex Mono, ui-monospace, monospace',
  'text-valign': 'bottom',
  'text-margin-y': 5,
  'text-background-color': SURFACE,
  'text-background-opacity': 0.85,
  'text-background-padding': 2,
};

const STYLE = [
  { selector: 'node', style: { ...label, 'border-width': 2, 'border-color': SURFACE, 'transition-property': 'opacity', 'transition-duration': 120 } },
  { selector: 'node[kind = "card"]', style: { shape: 'ellipse', 'background-color': GRAPH.card, width: 26, height: 26 } },
  { selector: 'node[kind = "device"]', style: { shape: 'round-rectangle', 'background-color': GRAPH.device, width: 30, height: 30 } },
  { selector: 'node[kind = "ip"]', style: { shape: 'diamond', 'background-color': GRAPH.ip, width: 30, height: 30 } },
  { selector: 'node[?blocked]', style: { 'background-color': GRAPH.blocked } },
  { selector: 'node[?seed]', style: { 'border-width': 3, 'border-color': INK.primary, width: 32, height: 32 } },
  { selector: 'node:selected', style: { 'border-width': 3, 'border-color': INK.primary, 'overlay-color': INK.primary, 'overlay-opacity': 0.08, 'overlay-padding': 6 } },
  {
    selector: 'edge',
    style: {
      width: 'mapData(weight, 1, 12, 1.5, 4)', 'line-color': GRAPH.edge, 'curve-style': 'bezier',
      'transition-property': 'opacity, line-color', 'transition-duration': 120,
    },
  },
  { selector: '.dim', style: { opacity: 0.15 } },
  { selector: 'edge.lit', style: { 'line-color': GRAPH.edgeActive } },
];

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function RingGraph({ ring, seedCardId, onSelect }) {
  const containerRef = useRef(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const cy = cytoscape({
      container: containerRef.current,
      style: STYLE,
      elements: buildElements(ring, seedCardId),
      minZoom: 0.2,
      maxZoom: 3,
    });
    // Spacing is generous on purpose: the shared device and IPs sit at the
    // centre of a ring, and their labels collide at the defaults.
    cy.layout({
      name: 'fcose', animate: false, padding: 50,
      nodeSeparation: 140, idealEdgeLength: 150, nodeRepulsion: 12000,
    }).run();

    // spec §7.6 -- the graph traces its edges once, 600ms in total whatever
    // the ring's size, then settles. Skipped under reduced motion.
    const edges = cy.edges();
    if (edges.length > 0 && !reducedMotion()) {
      const perEdge = 600 / edges.length;
      edges.forEach((edge, i) => {
        edge.style('opacity', 0);
        edge.animate({ style: { opacity: 1 } }, { duration: Math.max(perEdge, 20), delay: i * perEdge, complete: () => edge.removeStyle('opacity') });
      });
    }

    // Hovering a node isolates it and everything one hop away.
    cy.on('mouseover', 'node', (evt) => {
      const hood = evt.target.closedNeighborhood();
      cy.elements().difference(hood).addClass('dim');
      hood.edges().addClass('lit');
      containerRef.current.style.cursor = 'pointer';
    });
    cy.on('mouseout', 'node', () => {
      cy.elements().removeClass('dim lit');
      containerRef.current.style.cursor = '';
    });
    cy.on('select', 'node', (evt) => {
      const node = evt.target;
      onSelectRef.current?.({
        ...node.data(),
        neighbours: node.neighborhood('node').map((n) => ({ id: n.data('entityId'), kind: n.data('kind') })),
      });
    });
    cy.on('unselect', 'node', () => onSelectRef.current?.(null));

    // Keeps the graph fitted when the panel resizes (fullscreen toggle, window resize).
    const observer = new ResizeObserver(() => { cy.resize(); cy.fit(undefined, 40); });
    observer.observe(containerRef.current);

    return () => { observer.disconnect(); cy.destroy(); };
  }, [ring, seedCardId]);

  return <div ref={containerRef} className="ring-canvas" role="img" aria-label={`Ring graph: ${ring.cardNodes.length} cards and ${ring.entityNodes.length} shared devices or IPs`} />;
}
