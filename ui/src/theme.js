// Literal colour values for the two renderers that cannot read CSS custom
// properties reliably: Cytoscape (canvas) and Recharts' SVG attributes. Kept
// in one file so they stay in step with styles.css :root.

export const INK = { primary: '#16181d', secondary: '#4b4f58', muted: '#6f737c' };
export const SURFACE = '#ffffff';
export const GRID = '#e6e5df';
export const AXIS = '#c9c8c0';

// One-series charts use a single hue; the ordinal ramp is the same hue stepped
// light to dark, for ordered buckets (score bands).
export const SERIES = '#2a78d6';
export const ORDINAL = ['#86b6ef', '#5598e7', '#2a78d6', '#184f95'];

// Severity is a state, so it wears the reserved status colours -- always next
// to a text label, never colour alone.
export const SEVERITY = { LOW: '#0ca30c', MEDIUM: '#fab219', HIGH: '#d03b3b' };

// Ring graph: three node kinds that must be told apart pairwise, so they take
// the three categorical slots that hold up under colour-vision deficiency.
export const GRAPH = {
  card: '#2a78d6',
  device: '#eb6834',
  ip: '#1baf7a',
  blocked: '#d03b3b',
  edge: '#c9c8c0',
  edgeActive: '#4b4f58',
};
