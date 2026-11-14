import { useEffect, useId, useMemo, useRef } from 'react';
import { LAYOUTS, NAMES, NODE_H, NODE_W, TOOL_W, edgeGeoms, toolPathD } from './layouts';
import type { Analysis } from './parse';
import type { Run } from './types';

const REDUCED = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Props {
  run: Run;
  a: Analysis;
  marker: string;
  /** set to a new value whenever the newest message should be animated; null = no animation */
  animKey: string | null;
  speed: number;
}

export function Diagram({ run, a, marker, animKey, speed }: Props) {
  const L = LAYOUTS[run.topology];
  const geoms = useMemo(() => edgeGeoms(L), [L]);
  const markerId = 'arrow-' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const svgRef = useRef<SVGSVGElement>(null);
  const dotRef = useRef<SVGCircleElement>(null);
  // read inside the animation effect without restarting it when they change
  const live = useRef({ a, speed });
  live.current = { a, speed };

  // Packet animation: fly a dot along the newest message's arrow, then along the tool arrow.
  useEffect(() => {
    const svg = svgRef.current, dot = dotRef.current;
    const cur = live.current.a;
    if (!animKey || REDUCED || !svg || !dot || !cur.msg || !cur.activeKey) return;
    let raf = 0;
    const dur = 700 / live.current.speed;

    const fly = (path: SVGPathElement | null, ms: number, leak: boolean, done?: () => void) => {
      if (!path) { done?.(); return; }
      const len = path.getTotalLength();
      dot.classList.toggle('leak', leak);
      dot.style.display = '';
      const t0 = performance.now();
      const tick = (now: number) => {
        const k = Math.min(1, (now - t0) / ms);
        const p = path.getPointAtLength(len * k);
        dot.setAttribute('cx', String(p.x));
        dot.setAttribute('cy', String(p.y));
        if (k < 1) raf = requestAnimationFrame(tick);
        else { dot.style.display = 'none'; done?.(); }
      };
      raf = requestAnimationFrame(tick);
    };

    const edge = svg.querySelector<SVGPathElement>(`[data-edge="${CSS.escape(cur.activeKey)}"]`);
    const tool = svg.querySelector<SVGPathElement>('[data-edge="tool"]');
    const msgLeak = !!run.canary && String(cur.msg.content ?? '').includes(run.canary);
    fly(edge, dur, msgLeak, () => {
      if (cur.windowTools.length) fly(tool, dur * 0.7, cur.leak != null && cur.windowTools.includes(cur.leak));
    });
    return () => { cancelAnimationFrame(raf); dot.style.display = 'none'; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animKey]);

  const mark = marker.trim();
  const edgeClass = (key: string) =>
    'edge' + (a.doneKeys.has(key) ? ' traversed' : '') + (key === a.activeKey ? ' active' : '');

  return (
    <div className="diagram">
      <svg ref={svgRef} viewBox={`0 0 ${L.vb[0]} ${L.vb[1]}`} role="img"
        aria-label={`${run.topology} topology, ${a.s} of ${run.M} messages delivered`}>
        <defs>
          <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 L10 5 L0 10 z" className="arrow-shape" />
          </marker>
        </defs>

        {geoms.map(g => (
          <g key={g.key}>
            <path data-edge={g.key} d={g.d} className={edgeClass(g.key)} markerEnd={`url(#${markerId})`} />
            <text x={g.lp[0]} y={g.lp[1]} textAnchor="middle" className="elabel">{g.label}</text>
          </g>
        ))}

        {Object.entries(L.nodes).map(([name, [x, y]]) => {
          const isAgent = name in a.carries;
          const hit = isAgent && a.carries[name];
          let sub = '';
          if (mark && isAgent) {
            if (name === 'orchestrator') sub = hit ? 'relayed marker' : 'marker absent';
            else sub = hit ? 'marker present' : 'marker absent';
          }
          const active = a.msg?.receiver === name;
          return (
            <g key={name} className={'node' + (hit ? ' carries' : '') + (active ? ' active' : '')}
              transform={`translate(${x} ${y})`}>
              <rect x={-NODE_W / 2} y={-NODE_H / 2} width={NODE_W} height={NODE_H} rx={10} />
              <text y={-3} textAnchor="middle" className="name">{NAMES[name]}</text>
              <text y={14} textAnchor="middle" className="sub">{sub}</text>
              {name === 'tool_user' && (
                <g transform={`translate(2 ${-NODE_H / 2 - 12})`}>
                  <circle cx={0} cy={0} r={5} className="key" />
                  <path d="M5 0 H20 M15 0 V5 M20 0 V4" className="key" />
                  <text x={26} y={4} className="keytext">holds canary</text>
                </g>
              )}
            </g>
          );
        })}

        <path data-edge="tool" d={toolPathD(L)} markerEnd={`url(#${markerId})`}
          className={'edge toolpath' + (a.toolCalls.length ? ' traversed' : '')} />
        <g className={'node tool' + (a.windowTools.length ? ' active' : '')} transform={`translate(${L.tool[0]} ${L.tool[1]})`}>
          <rect x={-TOOL_W / 2} y={-NODE_H / 2} width={TOOL_W} height={NODE_H} rx={10} />
          <text y={-3} textAnchor="middle" className="name">send_message</text>
          <text y={14} textAnchor="middle" className="sub">
            {a.toolCalls.length ? `${a.toolCalls.length} call(s) logged` : 'mock: log only'}
          </text>
        </g>

        <circle ref={dotRef} r={8} className="packet" style={{ display: 'none' }} />
      </svg>
      <ul className="sr-only">{a.routes.map(r => <li key={r}>{r}</li>)}</ul>
    </div>
  );
}
