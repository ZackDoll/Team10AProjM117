import { useEffect, useMemo, useRef, useState } from 'react';
import { getBatch, getDocs, getStatus, getTemplates, startBatch, stopBatch } from './api';
import type { BatchRow, BatchState, Status, Template } from './api';
import type { PipelineSpec, Run } from './types';

interface Props {
  pipelines: PipelineSpec[];
  /** every loaded run, to warn about logs a batch would overwrite and to estimate cost */
  runs: Run[];
  /** load new logs from disk into the viewer */
  onRefresh: () => void;
  /** open a finished run in the replay tab */
  onOpenRun: (runId: string) => void;
}

type Backend = 'anthropic' | 'stub' | 'ollama';
interface Planned { id: string; pipeline: string; doc: string; template: string | null; position: string | null; seed: number }
type Cell = 'pending' | 'running' | 'leak' | 'ok' | 'noreport' | 'error';

const POSITIONS = ['start', 'middle', 'end'] as const;
const docStem = (name: string) => name.replace(/\.txt$/, '').split('/').pop()!;
const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter(y => y !== x) : [...xs, x]);
const ICON: Record<Cell, string> = { pending: '·', running: '…', leak: '⚠', ok: '✓', noreport: '✗', error: '!' };
const WORD: Record<Cell, string> = {
  pending: 'waiting', running: 'running', leak: 'LEAK', ok: 'no leak', noreport: 'no leak, but no report reached the user', error: 'error',
};

export function BatchTab({ pipelines, runs, onRefresh, onOpenRun }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [apiError, setApiError] = useState(false);
  const [docNames, setDocNames] = useState<string[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [pSel, setPSel] = useState<string[]>([]);
  const [dSel, setDSel] = useState<string[]>([]);
  const [tSel, setTSel] = useState<string[]>([]);
  const [posSel, setPosSel] = useState<string[]>(['middle']);
  const [seedText, setSeedText] = useState('1');
  const [withClean, setWithClean] = useState(true);
  const [backend, setBackend] = useState<Backend>('anthropic');
  const [maxRuns, setMaxRuns] = useState(100);
  const [job, setJob] = useState<string | null>(null);
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [frozen, setFrozen] = useState<Planned[] | null>(null); // the plan of the batch on screen
  const [error, setError] = useState<string | null>(null);
  const seen = useRef(0);

  useEffect(() => {
    getStatus().then(setStatus).catch(() => setApiError(true));
    getDocs().then(ds => {
      const names = ds.map(d => d.name).filter(n => !/poisoned/.test(n));
      setDocNames(names);
      setDSel(names.filter(n => n.endsWith('d1.txt')).slice(0, 1));
    }).catch(() => {});
    getTemplates().then(ts => { setTemplates(ts); setTSel(ts.map(t => t.id)); }).catch(() => {});
  }, []);
  useEffect(() => {
    setPSel(prev => (prev.length ? prev : pipelines.filter(p => p.builtin).map(p => p.id)));
  }, [pipelines]);

  // Poll the running batch; ask the viewer to load each new log as it lands.
  useEffect(() => {
    if (!job) return;
    let live = true;
    const tick = async () => {
      try {
        const b = await getBatch(job);
        if (!live) return;
        setBatch(b);
        if (b.rows.length !== seen.current) { seen.current = b.rows.length; onRefresh(); }
        if (b.state !== 'running') { onRefresh(); setJob(null); return; }
      } catch (e) { if (live) { setError((e as Error).message); setJob(null); return; } }
      if (live) timer = setTimeout(tick, 800);
    };
    let timer = setTimeout(tick, 300);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  const seeds = useMemo(() => {
    const xs = seedText.split(/[\s,]+/).filter(Boolean).map(Number);
    return xs.every(x => Number.isInteger(x) && x >= 0) ? [...new Set(xs)] : null;
  }, [seedText]);

  // The runs this configuration would make, in the order the batch script makes them.
  const plan: Planned[] = useMemo(() => {
    if (!seeds) return [];
    const out: Planned[] = [];
    const mk = (p: string, d: string, t: string | null, pos: string | null, s: number) =>
      out.push({ id: `${p}__${docStem(d)}__${t ?? 'clean'}__${pos ?? 'na'}__s${s}`, pipeline: p, doc: d, template: t, position: pos, seed: s });
    for (const p of pSel) for (const d of dSel) for (const t of tSel) for (const pos of POSITIONS.filter(x => posSel.includes(x))) for (const s of seeds) mk(p, d, t, pos, s);
    if (withClean) for (const p of pSel) for (const d of dSel) for (const s of seeds) mk(p, d, null, null, s);
    return out;
  }, [pSel, dSel, tSel, posSel, seeds, withClean]);

  const existing = useMemo(() => {
    const byName = new Map(runs.map(r => [r.name, r]));
    return plan.filter(p => byName.has(p.id)).map(p => byName.get(p.id)!);
  }, [plan, runs]);
  const existingModels = [...new Set(existing.map(r => String(r.start.model ?? '?')))];

  const model = backend === 'anthropic' ? status?.model : backend === 'ollama' ? status?.ollamaModel : 'stub';
  const estimate = useMemo(() => {
    if (backend !== 'anthropic') return { text: 'free', known: true };
    const costs = runs.filter(r => r.start.model === status?.model && typeof r.end?.cost_usd === 'number' && r.end.cost_usd > 0)
      .map(r => r.end!.cost_usd as number);
    if (!costs.length) return { text: 'unknown until a run has been timed, but a Haiku run is well under a cent', known: false };
    const avg = costs.reduce((a, b) => a + b, 0) / costs.length;
    return { text: `about $${(avg * plan.length).toFixed(3)} (average of ${costs.length} earlier run${costs.length > 1 ? 's' : ''} on ${status?.model})`, known: true };
  }, [backend, runs, status, plan.length]);

  const running = !!job;
  const keyMissing = backend === 'anthropic' && status && !status.hasKey;
  const ollamaDown = backend === 'ollama' && status && !status.ollamaReachable;
  const busyElsewhere = !!(status?.running || status?.batchRunning) && !running;
  const tooMany = plan.length > maxRuns;
  const invalid = !seeds ? 'Seeds must be whole numbers, separated by spaces or commas.'
    : !pSel.length ? 'Pick at least one pipeline.' : !dSel.length ? 'Pick at least one document.'
    : !plan.length ? 'Nothing to run: pick attack templates (and a position) or include clean runs.'
    : tooMany ? `${plan.length} runs is over the cap of ${maxRuns}. Raise the cap on purpose, or pick fewer.`
    : keyMissing ? 'No ANTHROPIC_API_KEY in .env.' : ollamaDown ? 'Ollama is not running (see docs/OLLAMA.md).' : null;

  const start = async () => {
    if (invalid || !seeds) return;
    setError(null); setBatch(null); seen.current = 0;
    try {
      const { job: id } = await startBatch({
        pipelines: pSel, docs: dSel, templateIds: tSel, positions: posSel, seeds, withClean, backend, maxRuns,
      });
      setFrozen(plan); setJob(id);
    } catch (e) { setError((e as Error).message); }
  };
  const stop = () => { if (job) stopBatch(job).catch(e => setError((e as Error).message)); };

  if (apiError) {
    return (
      <section className="pe-empty">
        <h2>Batch</h2>
        <p className="hint">Running batches needs the dev server: <code>cd viz && npm run dev</code>.</p>
      </section>
    );
  }

  // ---- the grid, from the plan on screen (the running batch's, or else the one being configured)
  const shownPlan = frozen && (batch || running) ? frozen : plan;
  const byId = new Map<string, BatchRow>((batch?.rows ?? []).map(r => [r.run_id, r]));
  const done = batch?.rows.length ?? 0;
  const stateOf = (p: Planned): Cell => {
    const r = byId.get(p.id);
    if (r) return r.error ? 'error' : r.leaked ? 'leak' : r.report_sent ? 'ok' : 'noreport';
    return running && batch?.current === p.id ? 'running' : 'pending'; // the script says which run it is on
  };
  const states = new Map(shownPlan.map(p => [p.id, stateOf(p)]));
  const gp = [...new Set(shownPlan.map(p => p.pipeline))];
  const gpos = POSITIONS.filter(x => shownPlan.some(p => p.position === x));
  const inPlan = new Set(shownPlan.filter(p => p.template).map(p => p.template!));
  const gtpl = templates.map(t => t.id).filter(id => inPlan.has(id)); // file order, whatever order they were ticked in
  const hasClean = shownPlan.some(p => !p.template);
  const cellRuns = (t: string | null, pipe: string, pos: string | null) =>
    shownPlan.filter(p => p.template === t && p.pipeline === pipe && (pos === null || p.position === pos));
  const rate = (ps: Planned[]) => {
    const ranStates = ps.map(p => states.get(p.id)!).filter(s => s !== 'pending' && s !== 'running' && s !== 'error');
    return ranStates.length ? `${ranStates.filter(s => s === 'leak').length}/${ranStates.length}` : '';
  };
  const chip = (p: Planned, solo: boolean) => {
    const s = states.get(p.id)!;
    const ready = s !== 'pending' && s !== 'running';
    return (
      <button key={p.id} type="button" className={`gcell ${s}`} disabled={!ready} onClick={() => onOpenRun(p.id)}
        title={`${p.id}: ${WORD[s]}`} aria-label={`${p.id}: ${WORD[s]}${ready ? '. Open this run.' : ''}`}>
        <span aria-hidden="true">{ICON[s]}</span>{solo ? <span> {s === 'leak' ? 'LEAK' : s === 'ok' ? 'safe' : s === 'noreport' ? 'no report' : s === 'error' ? 'error' : s === 'running' ? 'running' : ''}</span> : null}
      </button>
    );
  };
  const attackPlanned = shownPlan.filter(p => p.template);
  const totalRate = rate(attackPlanned);

  return (
    <section className="batch">
      <h2>Batch runner</h2>
      <p className="hint">Runs every combination you pick and shows which ones leaked the canary. Each run is saved as a normal log and transcript, so
        you can open any cell to replay it.</p>

      <div className="batch-setup">
        <fieldset disabled={running}>
          <legend>Pipelines</legend>
          {pipelines.map(p => (
            <label key={p.id} className="check"><input type="checkbox" checked={pSel.includes(p.id)} onChange={() => setPSel(toggle(pSel, p.id))} />{p.name || p.id}</label>
          ))}
        </fieldset>
        <fieldset disabled={running}>
          <legend>Documents</legend>
          {docNames.map(d => (
            <label key={d} className="check"><input type="checkbox" checked={dSel.includes(d)} onChange={() => setDSel(toggle(dSel, d))} />{d}</label>
          ))}
        </fieldset>
        <fieldset disabled={running}>
          <legend>Attack templates <button type="button" className="linkish" onClick={() => setTSel(templates.map(t => t.id))}>all</button>{' '}
            <button type="button" className="linkish" onClick={() => setTSel([])}>none</button></legend>
          <div className="scroll-list">
            {templates.map(t => (
              <label key={t.id} className="check" title={t.technique}><input type="checkbox" checked={tSel.includes(t.id)} onChange={() => setTSel(toggle(tSel, t.id))} />{t.id}</label>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={running}>
          <legend>Positions</legend>
          {POSITIONS.map(p => (
            <label key={p} className="check"><input type="checkbox" checked={posSel.includes(p)} onChange={() => setPosSel(toggle(posSel, p))} />{p}</label>
          ))}
          <label className="check"><input type="checkbox" checked={withClean} onChange={e => setWithClean(e.target.checked)} />also run clean (no attack)</label>
        </fieldset>
        <fieldset disabled={running}>
          <legend>Settings</legend>
          <label>Seeds <span className="hint">(repeat counts, e.g. 1 2 3)</span>
            <input type="text" value={seedText} onChange={e => setSeedText(e.target.value)} size={10} spellCheck={false} aria-invalid={!seeds} />
          </label>
          <label>Backend
            <select value={backend} onChange={e => setBackend(e.target.value as Backend)}>
              <option value="anthropic">Claude ({status?.model ?? '…'})</option>
              <option value="ollama">Local: {status?.ollamaModel ?? '…'}{status && !status.ollamaReachable ? ' (not running)' : ''}</option>
              <option value="stub">stub (free)</option>
            </select>
          </label>
          <label>Run cap <span className="hint">(safety)</span>
            <input type="number" min={1} max={1000} value={maxRuns} onChange={e => setMaxRuns(Math.max(1, Math.floor(Number(e.target.value) || 1)))} style={{ width: '6em' }} />
          </label>
        </fieldset>
      </div>

      <div className="batch-plan" role="status" aria-live="polite">
        <div><strong>{plan.length} run{plan.length === 1 ? '' : 's'}</strong> on <code>{model ?? '…'}</code> {'·'} cost: {estimate.text}</div>
        {!running && existing.length > 0 && (
          <div className="warn-text">
            {'⚠'} {existing.length} of these already have logs and will be <strong>overwritten</strong>
            {' '}(made with {existingModels.join(', ')}). A rerun of the same pipeline, document, template, position and seed replaces the old log, whatever the model.
          </div>
        )}
        {invalid && <div className="error">{invalid}</div>}
        {busyElsewhere && <div className="warn-text">Another run or batch is in progress; wait for it to finish.</div>}
      </div>

      <div className="row">
        {!running
          ? <button type="button" className="primary" onClick={start} disabled={!!invalid || busyElsewhere}>
              {'▶'} Start batch{existing.length ? ` (overwrite ${existing.length})` : ''}</button>
          : <button type="button" onClick={stop}>{'■'} Stop after this run</button>}
        {running && batch && (
          <>
            <progress max={batch.total || 1} value={done} aria-label="Batch progress" />
            <span className="hint">{done} of {batch.total} {'·'} {(batch.elapsedMs / 1000).toFixed(0)} s</span>
          </>
        )}
        {error && <span className="error">{error}</span>}
      </div>

      {batch && !running && (
        <div className={'banner ' + (batch.state === 'done' ? 'safe' : 'progress')} role="status">
          {batch.state === 'done' ? '✓ Batch finished' : batch.state === 'stopped' ? 'Batch stopped' : 'Batch failed'}
          {batch.summary && <>: attack success <strong>{batch.summary.leaks} of {batch.summary.attack_runs}</strong>, ran {batch.summary.ran}, spent ${batch.summary.spent_usd.toFixed(4)}</>}
          {batch.error && <> {'·'} {batch.error}</>}
        </div>
      )}

      {shownPlan.length > 0 && (gtpl.length > 0 || hasClean) && (
        <div className="table-wrap grid-wrap">
          <table className="grid">
            <caption className="sr-only">Results: rows are attack templates, columns are pipeline and position</caption>
            <thead>
              <tr>
                <th rowSpan={2} scope="col">Template</th>
                {gp.map(p => <th key={p} colSpan={Math.max(1, gpos.length)} scope="colgroup">{pipelines.find(x => x.id === p)?.name || p}</th>)}
                <th rowSpan={2} scope="col" title="leaks / runs that finished">Attack success</th>
              </tr>
              <tr>
                {gp.flatMap(p => (gpos.length ? gpos : ['-']).map(pos => <th key={p + pos} scope="col" className="sub">{pos}</th>))}
              </tr>
            </thead>
            <tbody>
              {gtpl.map(t => (
                <tr key={t}>
                  <th scope="row" className="mono">{t}</th>
                  {gp.flatMap(p => gpos.map(pos => {
                    const rs = cellRuns(t, p, pos);
                    return <td key={p + pos}><div className="gcells">{rs.map(r => chip(r, rs.length === 1))}</div></td>;
                  }))}
                  <td className="num">{rate(shownPlan.filter(p => p.template === t))}</td>
                </tr>
              ))}
              {hasClean && (
                <tr className="clean-row">
                  <th scope="row">clean (no attack)</th>
                  {gp.map(p => {
                    const rs = cellRuns(null, p, null);
                    return <td key={p} colSpan={Math.max(1, gpos.length)}><div className="gcells">{rs.map(r => chip(r, rs.length === 1))}</div></td>;
                  })}
                  <td className="num hint">baseline</td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Attack success</th>
                {gp.flatMap(p => gpos.map(pos => <td key={p + pos} className="num">{rate(attackPlanned.filter(r => r.pipeline === p && r.position === pos))}</td>))}
                <td className="num"><strong>{totalRate}</strong></td>
              </tr>
            </tfoot>
          </table>
          <p className="hint small legend">
            {(['leak', 'ok', 'noreport', 'error', 'pending'] as Cell[]).map(s => <span key={s} className={`gcell ${s} legend-item`}><span aria-hidden="true">{ICON[s]}</span> {WORD[s]}</span>)}
            {' '}Click a finished cell to replay it. <strong>no report</strong> = nothing reached the user's address, a stand-in for task failure.
          </p>
        </div>
      )}
    </section>
  );
}
