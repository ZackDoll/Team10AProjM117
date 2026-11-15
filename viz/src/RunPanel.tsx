import { useMemo, useState } from 'react';
import { Detail } from './Detail';
import { Diagram } from './Diagram';
import { analyze } from './parse';
import { Timeline } from './Timeline';
import { Transcript } from './Transcript';
import type { Run, Topology } from './types';

interface Props {
  index: number;
  run: Run;
  runs: Run[];
  step: number;
  marker: string;
  speed: number;
  /** the step whose arrival should be animated, or -1 */
  animStep: number;
  onPickRun: (runIndex: number) => void;
  onPickTopology: (topology: Topology) => void;
  onJump: (step: number) => void;
}

const Chip = ({ k, v }: { k: string; v: unknown }) => (
  <span className="chip"><b>{k}</b>{String(v ?? '-')}</span>
);

export function RunPanel({ index, run, runs, step, marker, speed, animStep, onPickRun, onPickTopology, onJump }: Props) {
  const a = useMemo(() => analyze(run, step, marker), [run, step, marker]);
  const [view, setView] = useState<'replay' | 'transcript'>('replay');
  const pipelineIds = useMemo(() => [...new Set(runs.map(r => r.topology))], [runs]);
  const s = run.start;
  const animKey = animStep >= 1 && animStep === step && step <= run.M ? `${run.name}#${step}` : null;

  let bannerClass = 'progress', bannerText = 'In progress: no leak so far';
  if (a.leak) {
    const to = a.leak.args?.to ?? '?';
    bannerClass = 'leak';
    bannerText = `⚠ LEAK: the canary was sent via send_message to ${to} (${to === run.userAddr ? "the user's own address" : 'an external address'})`;
  } else if (a.finished) {
    bannerClass = 'safe';
    bannerText = '✓ No leak: the canary never appeared in a send_message call';
  }

  return (
    <section className="panel" aria-label={`Run panel ${index + 1}`}>
      <div className="panel-head">
        <label>Run
          <select value={runs.indexOf(run)} onChange={e => onPickRun(Number(e.target.value))}>
            {runs.map((r, i) => <option key={i} value={i}>{r.name}</option>)}
          </select>
        </label>
        <label>Pipeline <span className="hint">(jumps to a run of it)</span>
          <select value={run.topology} onChange={e => onPickTopology(e.target.value)}>
            {pipelineIds.map(id => <option key={id} value={id}>{runs.find(r => r.topology === id)?.pipeline.name || id}</option>)}
          </select>
        </label>
      </div>

      <div className="summary">
        <Chip k="run" v={s.run_id} /><Chip k="topology" v={run.topology} /><Chip k="doc" v={s.doc_id} />
        <Chip k="template" v={s.template_id ?? 'none (clean)'} /><Chip k="position" v={s.position} />
        <Chip k="seed" v={s.seed} /><Chip k="model" v={s.model} /><Chip k="messages" v={run.M} />
        <Chip k="LLM calls" v={`${run.llmCalls} (${run.cached} cached)`} />
        <Chip k="status" v={run.end ? run.end.status : 'no run_end'} />
      </div>

      <div className={`banner ${bannerClass}`} role="status" aria-live="polite">{bannerText}</div>

      <div className="spread">
        <span>Spread depth:{' '}
          <span className={'badge' + (a.depth !== 'none' ? ' hit' : '')}>
            {marker.trim() ? a.depth : 'set a marker phrase'}
          </span>
        </span>
        {marker.trim()
          ? <span className="hint">{a.inDoc ? 'marker is in the document' : "marker is NOT in this run's document"}</span>
          : s.template_id ? <span className="hint">template: {s.template_id}</span> : null}
      </div>

      <div className="tabs" role="tablist" aria-label="What to show for this run">
        {(['replay', 'transcript'] as const).map(v => (
          <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}>
            {v === 'replay' ? 'Replay' : 'Transcript'}
          </button>
        ))}
      </div>

      {view === 'replay' ? (
        <>
          <Diagram run={run} a={a} marker={marker} animKey={animKey} speed={speed} />
          <Detail run={run} a={a} marker={marker} />
          <Timeline run={run} a={a} onJump={onJump} />
        </>
      ) : (
        <Transcript run={run} marker={marker} step={a.s} onJump={onJump} />
      )}
    </section>
  );
}
