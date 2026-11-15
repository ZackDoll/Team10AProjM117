import { useId, useMemo } from 'react';
import { NODE_H, NODE_W, TOOL_W, edgeGeoms, labelOf, layoutFor, toolPathD } from './layouts';
import type { PipelineSpec } from './types';

/** A still picture of a pipeline's graph (no run, no animation). Tolerates half-built specs. */
export function GraphPreview({ spec }: { spec: PipelineSpec }) {
  const L = useMemo(() => layoutFor(spec), [spec]);
  const geoms = useMemo(() => edgeGeoms(L), [L]);
  const markerId = 'pv-' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const type = (id: string) => spec.nodes.find(n => n.id === id);

  return (
    <div className="diagram preview">
      <svg viewBox={`0 0 ${L.vb[0]} ${L.vb[1]}`} role="img"
        aria-label={`Graph of the ${spec.name || spec.id} pipeline: ${spec.nodes.length} agents`}>
        <defs>
          <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 L10 5 L0 10 z" className="arrow-shape" />
          </marker>
        </defs>
        {geoms.map((g, i) => (
          <g key={`${g.key}#${i}`}> {/* half-built specs can repeat an edge, so the index keeps keys unique */}
            <path d={g.d} className="edge traversed" markerEnd={`url(#${markerId})`} />
            <text x={g.lp[0]} y={g.lp[1]} textAnchor="middle" className="elabel">{g.label}</text>
          </g>
        ))}
        {Object.entries(L.nodes).map(([id, [x, y]]) => {
          const n = type(id);
          return (
            <g key={id} className={'node' + (spec.output === id ? ' active' : '')} transform={`translate(${x} ${y})`}>
              <rect x={-NODE_W / 2} y={-NODE_H / 2} width={NODE_W} height={NODE_H} rx={10} />
              <text y={-3} textAnchor="middle" className="name">{labelOf(spec, id)}</text>
              <text y={14} textAnchor="middle" className="sub">
                {id === 'user' ? '' : n?.type === 'hub' ? 'hub' : n?.type === 'tool_agent' ? 'tool agent' : 'agent'}
              </text>
              {n?.holds_canary && (
                <g transform={`translate(2 ${-NODE_H / 2 - 12})`}>
                  <circle cx={0} cy={0} r={5} className="key" />
                  <path d="M5 0 H20 M15 0 V5 M20 0 V4" className="key" />
                  <text x={26} y={4} className="keytext">holds canary</text>
                </g>
              )}
            </g>
          );
        })}
        {L.toolBoxes.map(box => (
          <g key={box.owner}>
            <path d={toolPathD(L, box)} markerEnd={`url(#${markerId})`} className="edge toolpath" />
            <g className="node tool" transform={`translate(${box.pos[0]} ${box.pos[1]})`}>
              <rect x={-TOOL_W / 2} y={-NODE_H / 2} width={TOOL_W} height={NODE_H} rx={10} />
              <text y={-3} textAnchor="middle" className="name">send_message</text>
              <text y={14} textAnchor="middle" className="sub">mock: log only</text>
            </g>
          </g>
        ))}
      </svg>
    </div>
  );
}
