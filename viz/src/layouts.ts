import { PRESET_FALLBACK } from './presets';
import type { PipelineSpec } from './types';

export const NODE_W = 130;
export const NODE_H = 56;
export const TOOL_W = 150;

interface EdgeDef { a: string; b: string; label: string; d?: string; lp?: [number, number] }
export interface ToolBox { owner: string; pos: [number, number]; side: 'right' | 'below' }
export interface Layout {
  vb: [number, number];
  nodes: Record<string, [number, number]>;
  /** one send_message box per tool agent */
  toolBoxes: ToolBox[];
  edges: EdgeDef[];
}

/** Display names for the two built-in pipelines (kept as they were drawn before pipelines were editable). */
export const NAMES: Record<string, string> = {
  user: 'User', reader: 'Reader', analyst: 'Analyst', tool_user: 'Tool user', orchestrator: 'Orchestrator',
};

const shape = (p: PipelineSpec) =>
  p.nodes.map(n => n.id).sort().join(',') + '|' + p.edges.map(e => `${e.from}>${e.to}`).sort().join(',');
const PRESET_SHAPES = new Map(Object.entries(PRESET_FALLBACK).map(([id, p]) => [shape(p), id]));

/** The built-in id a pipeline is drawn as, or null for a custom graph. */
export const presetOf = (p: PipelineSpec): string | null => PRESET_SHAPES.get(shape(p)) ?? null;

export function labelOf(p: PipelineSpec, id: string): string {
  if (id === 'user') return 'User';
  // The built-in names only apply to the presets themselves. A custom pipeline that happens to
  // have the same shape (say, a copy of chain with edited labels) shows its own labels.
  if (presetOf(p) === p.id && NAMES[id]) return NAMES[id];
  return p.nodes.find(n => n.id === id)?.label || id;
}

// Hand-tuned layouts for the two presets.
const PRESET_LAYOUTS: Record<string, Layout> = {
  chain: {
    vb: [1000, 300],
    nodes: { user: [90, 100], reader: [290, 100], analyst: [490, 100], tool_user: [690, 100] },
    toolBoxes: [{ owner: 'tool_user', pos: [900, 100], side: 'right' }],
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
    toolBoxes: [{ owner: 'tool_user', pos: [900, 390], side: 'right' }],
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

const COL = 200;      // horizontal distance between columns
const TOP = 110;      // y of the first row (room above for the arc back to the user)
const ROW = 110;      // vertical distance between rows
const TOOL_DROP = 100; // how far below its agent a send_message box sits

/** Layered left-to-right layout for any pipeline: column = longest path from the user, so a hub's
 *  spokes get their own column between the hub and whatever the hub feeds. Tolerates invalid
 *  specs (cycles, unreachable nodes) so the editor can preview while you are still wiring them. */
function generic(p: PipelineSpec): Layout {
  const spokesOf = new Map<string, string[]>();
  const spokeSet = new Set<string>();
  for (const n of p.nodes) {
    if (n.type === 'hub') {
      const ss = (n.spokes ?? []).filter(s => p.nodes.some(m => m.id === s));
      spokesOf.set(n.id, ss);
      ss.forEach(s => spokeSet.add(s));
    }
  }
  const ids = p.nodes.map(n => n.id);
  const main = ids.filter(i => !spokeSet.has(i));
  const depth: Record<string, number> = { user: 0 };
  for (let pass = 0; pass <= main.length; pass++) {
    let changed = false;
    for (const e of p.edges) {
      if (e.to === 'user' || !(e.from in depth) || spokeSet.has(e.to)) continue;
      const d = depth[e.from] + (spokesOf.has(e.from) ? 2 : 1);
      if ((depth[e.to] ?? -1) < d) { depth[e.to] = d; changed = true; }
    }
    if (!changed) break;
  }
  for (const i of main) if (!(i in depth)) depth[i] = 1;
  for (const [h, ss] of spokesOf) ss.forEach(s => { depth[s] = (depth[h] ?? 1) + 1; });

  const cols = new Map<number, string[]>();
  for (const i of ['user', ...ids]) {
    const d = Math.min(depth[i] ?? 1, 12);
    cols.set(d, [...(cols.get(d) ?? []), i]);
  }
  const toolIds = p.nodes.filter(n => n.type === 'tool_agent').map(n => n.id);
  const rows = Math.max(...[...cols.values()].map(c => c.length));
  // spread the rows further apart only if a send_message box would land on the node below it
  const boxCollides = toolIds.some(t => {
    const col = cols.get(Math.min(depth[t] ?? 1, 12))!;
    return col.indexOf(t) < col.length - 1;
  });
  const gap = boxCollides ? ROW + TOOL_DROP + 20 : ROW;
  const maxDepth = Math.max(...cols.keys());

  const nodes: Record<string, [number, number]> = {};
  for (const [d, list] of cols) {
    list.forEach((id, k) => { nodes[id] = [90 + d * COL, TOP + ((rows - list.length) / 2 + k) * gap]; });
  }
  const toolBoxes: ToolBox[] = toolIds.map(id => ({ owner: id, pos: [nodes[id][0], nodes[id][1] + TOOL_DROP], side: 'below' }));

  const edges: EdgeDef[] = [];
  for (const e of p.edges) {
    if (!nodes[e.from] || !nodes[e.to]) continue;
    if (e.to === 'user') {
      // arc over the top, so it never crosses the send_message box under the agent
      const [ox, oy] = nodes[e.from], [ux, uy] = nodes.user;
      const sx = ox - 30, sy = oy - NODE_H / 2 - 4, ex = ux, ey = uy - NODE_H / 2 - 4;
      edges.push({ a: e.from, b: 'user', label: e.label || 'final report',
        d: `M${sx} ${sy} C${sx} 8 ${ex} 8 ${ex} ${ey}`, lp: [(sx + ex) / 2, 26] });
    } else {
      edges.push({ a: e.from, b: e.to, label: e.label ?? '' });
    }
  }
  for (const [h, ss] of spokesOf) {
    for (const s of ss) {
      edges.push({ a: h, b: s, label: `to ${(p.nodes.find(n => n.id === s)?.label ?? s).toLowerCase()}` });
      edges.push({ a: s, b: h, label: 'reply' });
    }
  }
  const bottom = Math.max(...Object.values(nodes).map(n => n[1] + NODE_H / 2),
    ...toolBoxes.map(b => b.pos[1] + NODE_H / 2)) + 30;
  return { vb: [Math.max(600, 90 + maxDepth * COL + 110), bottom], nodes, toolBoxes, edges };
}

export function layoutFor(p: PipelineSpec): Layout {
  const preset = presetOf(p);
  return preset ? PRESET_LAYOUTS[preset] : generic(p);
}

export interface EdgeGeom { key: string; d: string; label: string; lp: [number, number] }

/** Straight arrows clipped to the node boxes; two-way pairs are drawn side by side. */
export function edgeGeoms(layout: Layout): EdgeGeom[] {
  const pairs = new Set(layout.edges.map(e => `${e.a}>${e.b}`));
  return layout.edges.map(e => {
    const key = `${e.a}>${e.b}`;
    if (e.d && e.lp) return { key, d: e.d, label: e.label, lp: e.lp };
    const A = layout.nodes[e.a], B = layout.nodes[e.b];
    let dx = B[0] - A[0], dy = B[1] - A[1];
    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
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

export function toolPathD(layout: Layout, box: ToolBox): string {
  const [bx, by] = box.pos, [ox, oy] = layout.nodes[box.owner];
  if (box.side === 'right') return `M${ox + NODE_W / 2 + 4} ${by} L${bx - TOOL_W / 2 - 4} ${by}`;
  return `M${ox} ${oy + NODE_H / 2 + 4} L${bx} ${by - NODE_H / 2 - 4}`;
}
