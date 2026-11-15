import { useMemo } from 'react';
import { diffWords, sameWords } from './diff';
import { Highlight } from './Highlight';
import { labelOf } from './layouts';
import { agentOrder, nodeOutputs } from './parse';
import type { Run } from './types';

interface Props {
  /** the run with the payload in the document */
  attacked: Run;
  /** the same pipeline, document, seed and model without it */
  clean: Run;
  marker: string;
}

/** What the payload changed, agent by agent: each agent's output in the clean run against the attacked run. */
export function DiffView({ attacked, clean, marker }: Props) {
  const rows = useMemo(() => {
    const A = nodeOutputs(attacked), C = nodeOutputs(clean);
    const m = marker.trim().toLowerCase();
    return agentOrder(attacked.pipeline, true).map(id => {
      const a = (A[id] ?? []).join('\n\n'), c = (C[id] ?? []).join('\n\n');
      const same = sameWords(c, a);
      return {
        id, label: labelOf(attacked.pipeline, id), type: attacked.pipeline.nodes.find(n => n.id === id)?.type, a, same,
        ops: same ? [] : diffWords(c, a),
        marker: !!m && a.toLowerCase().includes(m) && !c.toLowerCase().includes(m),
        canary: !!attacked.canary && a.includes(attacked.canary),
      };
    });
  }, [attacked, clean, marker]);

  const changed = rows.filter(r => !r.same).length;
  const firstChange = rows.find(r => !r.same);
  const firstMarker = rows.find(r => r.marker);
  const canaryAt = rows.find(r => r.canary);

  return (
    <section className="diff" aria-label="Clean run compared with attacked run">
      <h3>Clean vs attacked: what the payload changed</h3>
      <p className="hint small">
        Left side of each change is the clean run <code>{clean.name}</code>; the right is the attacked run <code>{attacked.name}</code>.
        <del>Struck-through</del> words are only in the clean run, <ins>underlined</ins> words only in the attacked run. A model's wording
        can also vary on its own, so a small change is not always the payload's doing.
      </p>
      <ul className="diff-summary">
        <li><strong>{changed} of {rows.length}</strong> agents produced different output.
          {firstChange ? <> The first to differ is <strong>{firstChange.label}</strong>.</> : ' The runs are identical.'}</li>
        <li>{marker.trim()
          ? (firstMarker ? <>The marker <code>{marker.trim()}</code> first shows up in <strong>{firstMarker.label}</strong>{' '}
            (new compared with the clean run).</> : <>The marker <code>{marker.trim()}</code> does not appear in any agent's output.</>)
          : <span className="hint">Set a marker phrase to see where the payload first shows up.</span>}</li>
        <li>{canaryAt
          ? <strong className="bad-text">{'⚠'} The canary appears in the output of {canaryAt.label}.</strong>
          : <>The canary does not appear in any agent's output.</>}</li>
      </ul>

      {rows.map(r => (
        <details key={r.id} className={'diff-node' + (r.same ? '' : ' changed')} open={!r.same}>
          <summary>
            <strong>{r.label}</strong> <code>{r.id}</code>{r.type === 'hub' ? <span className="hint"> hub: relays messages</span> : null}
            {' '}<span className="badge">{r.same ? 'identical' : 'changed'}</span>
            {r.marker && <span className="badge hit">marker appears here</span>}
            {r.canary && <span className="badge bad">{'⚠'} canary here</span>}
          </summary>
          {r.same
            ? <pre className="content"><Highlight text={r.a || '(no output)'} canary={attacked.canary} marker={marker} /></pre>
            : (
              <pre className="content diff-body">
                {r.ops.map((o, i) => (
                  <span key={i}>
                    {o.op === 'del' ? <del>{o.text}</del>
                      : o.op === 'add' ? <ins><Highlight text={o.text} canary={attacked.canary} marker={marker} /></ins>
                      : o.text}
                    {o.text.endsWith('\n') ? '' : ' '}
                  </span>
                ))}
              </pre>
            )}
        </details>
      ))}
    </section>
  );
}
