import type { Topology } from './types';

export const NODE_W = 130;
export const NODE_H = 56;
export const TOOL_W = 150;

interface EdgeDef { a: string; b: string; label: string; d?: string; lp?: [number, number] }
export interface Layout {
  vb: [number, number];
  nodes: Record<string, [number, number]>;
  tool: [number, number];
  edges: EdgeDef[];
}

export const NAMES: Record<string, string> = {
  user: 'User', reader: 'Reader', analyst: 'Analyst', tool_user: 'Tool user', orchestrator: 'Orchestrator',
};

export const LAYOUTS: Record<Topology, Layout> = {
  chain: {
    vb: [1000, 300],
    nodes: { user: [90, 100], reader: [290, 100], analyst: [490, 100], tool_user: [690, 100] },
    tool: [900, 100],
    edges: [
      { a: 'user', b: 'reader', label: 'document' },
      { a: 'reader', b: 'analyst', label: 'summary' },
      { a: 'analyst', b: 'tool_user', label: 'answers' },
      { a: 'tool_user', b: 'user', label: 'final report', d: 'M690 128 C690 270 90 270 90 128', lp: [390, 250] },
    ],
  },
  orchestrator: {
    vb: [1000, 460],
    nodes: { user: [90, 230], orchestrator: [330, 230], reader: [640, 70], analyst: [640, 230], tool_user: [640, 390] },
    tool: [900, 390],
    edges: [
      { a: 'user', b: 'orchestrator', label: 'task + document' },
      { a: 'orchestrator', b: 'reader', label: 'to reader' },
      { a: 'reader', b: 'orchestrator', label: 'summary' },
      { a: 'orchestrator', b: 'analyst', label: 'to analyst' },
      { a: 'analyst', b: 'orchestrator', label: 'answers' },
      { a: 'orchestrator', b: 'tool_user', label: 'to tool user' },
      { a: 'tool_user', b: 'orchestrator', label: 'report' },
    ],
  },
};

export interface EdgeGeom { key: string; d: string; label: string; lp: [number, number] }

/** Straight arrows clipped to the node boxes; two-way pairs are drawn side by side. */
export function edgeGeoms(layout: Layout): EdgeGeom[] {
  const pairs = new Set(layout.edges.map(e => `${e.a}>${e.b}`));
  return layout.edges.map(e => {
    const key = `${e.a}>${e.b}`;
    if (e.d && e.lp) return { key, d: e.d, label: e.label, lp: e.lp };
    const A = layout.nodes[e.a], B = layout.nodes[e.b];
    let dx = B[0] - A[0], dy = B[1] - A[1];
    const len = Math.hypot(dx, dy); dx /= len; dy /= len;
    const t = dx ? NODE_W / 2 / Math.abs(dx) : Infinity;
    const u = dy ? NODE_H / 2 / Math.abs(dy) : Infinity;
    const clip = Math.min(t, u) + 4;
    const reverse = pairs.has(`${e.b}>${e.a}`);
    const off = reverse ? 12 : 0, nx = -dy * off, ny = dx * off;
    const x1 = A[0] + dx * clip + nx, y1 = A[1] + dy * clip + ny;
    const x2 = B[0] - dx * clip + nx, y2 = B[1] - dy * clip + ny;
    const side = reverse ? 17 : -15;
    return { key, d: `M${x1} ${y1} L${x2} ${y2}`, label: e.label, lp: [(x1 + x2) / 2 - dy * side, (y1 + y2) / 2 + dx * side + 4] };
  });
}

export function toolPathD(layout: Layout): string {
  const [tx, ty] = layout.tool, tu = layout.nodes.tool_user;
  return `M${tu[0] + NODE_W / 2 + 4} ${ty} L${tx - TOOL_W / 2 - 4} ${ty}`;
}
