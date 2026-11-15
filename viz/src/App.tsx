import { useCallback, useEffect, useRef, useState } from 'react';
import { getDocs, getLogs, getPipelines, getTemplates, idFromName, runAndFollow } from './api';
import type { Template } from './api';
import { BatchTab } from './BatchTab';
import { DiffView } from './DiffView';
import { findClean, parseRun } from './parse';
import { PipelineEditor } from './PipelineEditor';
import { RunForm } from './RunForm';
import { RunPanel } from './RunPanel';
import { RunsTable } from './RunsTable';
import { SAMPLES } from './samples';
import type { PipelineSpec, Run, Topology } from './types';

type Tab = 'replay' | 'runs' | 'batch' | 'pipelines';
const TABS: Tab[] = ['replay', 'runs', 'batch', 'pipelines'];

const label = (n: string) => n.replace(/^sample_/, '').replace(/\.jsonl?$/, '');
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// Parse the bundled logs once, at startup.
const initialErrors: string[] = [];
const INITIAL_RUNS: Run[] = [];
for (const s of SAMPLES) {
  try { INITIAL_RUNS.push(parseRun(label(s.name), s.text)); } catch (e) { initialErrors.push((e as Error).message); }
}

// URL options, e.g. ?a=chain_leak&b=orchestrator_leak&compare=1&step=4&marker=phrase&play=1&speed=2
const q = new URLSearchParams(location.search);
const findRun = (runs: Run[], name: string | null) => {
  if (!name) return -1;
  const exact = runs.findIndex(r => r.name === name);
  return exact >= 0 ? exact : runs.findIndex(r => r.name.includes(name));
};
/** Default second panel: a run with the other topology and the same leak outcome. */
const defaultB = (runs: Run[], a: number) => {
  const cur = runs[a];
  const i = runs.findIndex(r => r.topology !== cur.topology && r.leaked === cur.leaked);
  const j = i >= 0 ? i : runs.findIndex(r => r.topology !== cur.topology);
  return j >= 0 ? j : a;
};

export default function App() {
  const [runs, setRuns] = useState<Run[]>(INITIAL_RUNS);
  const [sel, setSel] = useState<[number, number]>(() => {
    if (!INITIAL_RUNS.length) return [0, 0];
    const a = Math.max(0, findRun(INITIAL_RUNS, q.get('a') || 'chain_leak'));
    const b = findRun(INITIAL_RUNS, q.get('b'));
    return [a, b >= 0 ? b : defaultB(INITIAL_RUNS, a)];
  });
  const [compare, setCompare] = useState(q.get('compare') === '1' || !!q.get('b'));
  const [step, setStep] = useState(parseInt(q.get('step') || '0', 10) || 0);
  const [animStep, setAnimStep] = useState(-1);
  const [playing, setPlaying] = useState(q.get('play') === '1');
  const [speed, setSpeed] = useState(parseFloat(q.get('speed') || '1') || 1);
  const [marker, setMarker] = useState(q.get('marker') || '');
  const [note, setNote] = useState<{ text: string; error: boolean }>({
    text: initialErrors.join(' '), error: initialErrors.length > 0,
  });
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>(TABS.find(t => t === q.get('tab')) ?? 'replay');
  const [templates, setTemplates] = useState<Template[]>([]);
  useEffect(() => { getTemplates().then(setTemplates).catch(() => { /* static build, or no templates file */ }); }, []);
  /** the phrase to trace for a run: its attack template's marker */
  const markerFor = useCallback((r: Run) =>
    templates.find(t => t.id === r.start.template_id)?.marker ?? '', [templates]);
  const [diffOn, setDiffOn] = useState(false);
  /** the clean twin of the attacked run in panel A does not exist yet */
  const [missingClean, setMissingClean] = useState<{ topology: string; docId: string; seed: number; model: string } | null>(null);
  const [cleanBusy, setCleanBusy] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<PipelineSpec[]>([]);
  const [pipelinesOk, setPipelinesOk] = useState(false); // false in a static build: there is no server
  const [requested, setRequested] = useState<{ id: string; n: number } | null>(null);

  const loadPipelines = () => getPipelines().then(p => { setPipelines(p); setPipelinesOk(true); })
    .catch(() => setPipelinesOk(false));
  useEffect(() => { loadPipelines(); }, []);

  const visible = compare ? [0, 1] : [0];
  const max = Math.max(0, ...visible.map(p => runs[sel[p]]?.M ?? 0));
  const cur = Math.min(step, max);

  // refs so window-level handlers always see current values
  const latest = useRef({ runs, compare });
  latest.current = { runs, compare };

  const go = (n: number, animate: boolean) => {
    const t = clamp(n, 0, max);
    setStep(t);
    setAnimStep(animate ? t : -1);
  };
  const pause = () => setPlaying(false);
  const jump = (n: number) => { pause(); go(n, false); };
  const togglePlay = () => {
    if (playing) { pause(); return; }
    if (cur >= max) go(0, false);
    setPlaying(true);
  };

  // Autoplay: advance one hop per tick until the end.
  useEffect(() => {
    if (!playing) return;
    if (cur >= max) { setPlaying(false); return; }
    const t = setTimeout(() => go(cur + 1, true), cur === 0 ? 150 : 1200 / speed);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, cur, max, speed]);

  // Keyboard: Space play/pause, arrows step, Home restart.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tab !== 'replay') return;
      if ((e.target as HTMLElement).closest('input, select, textarea, button')) return;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') { pause(); go(cur + 1, true); }
      else if (e.key === 'ArrowLeft') { pause(); go(cur - 1, false); }
      else if (e.key === 'Home') { pause(); go(0, false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Loading logs: file picker or drag and drop anywhere on the page.
  const loadFiles = async (files: File[]) => {
    const added: Run[] = [];
    let error: string | null = null;
    for (const f of files) {
      try { added.push(parseRun(label(f.name), await f.text())); } catch (e) { error = (e as Error).message; }
    }
    if (error) setNote({ text: error, error: true });
    if (!added.length) return;
    const base = latest.current.runs.length;
    const both = latest.current.compare && added.length > 1;
    setRuns(prev => [...prev, ...added]);
    setSel(prev => [base, both ? base + 1 : prev[1]]);
    setPlaying(false); setStep(0); setAnimStep(-1);
    if (!error) setNote({ text: `Loaded ${added.length} log(s): ${added.map(r => r.name).join(', ')}`, error: false });
  };
  const loadRef = useRef(loadFiles);
  loadRef.current = loadFiles;
  useEffect(() => {
    const over = (e: DragEvent) => { e.preventDefault(); setDragOver(true); };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDragOver(false); };
    const drop = (e: DragEvent) => {
      e.preventDefault(); setDragOver(false);
      if (e.dataTransfer?.files.length) loadRef.current([...e.dataTransfer.files]);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  // Add or replace a run by name (a rerun with the same run id replaces the old one).
  const upsert = (name: string, text: string): { run: Run; index: number; prevM: number } | null => {
    let run: Run;
    try { run = parseRun(label(name), text); } catch { return null; } // no run_start yet
    const cur = latest.current.runs;
    const i = cur.findIndex(r => r.name === run.name);
    const next = i >= 0 ? cur.map((r, k) => (k === i ? run : r)) : [...cur, run];
    latest.current.runs = next; // polling can fire again before React re-renders
    setRuns(next);
    return { run, index: i >= 0 ? i : next.length - 1, prevM: i >= 0 ? cur[i].M : 0 };
  };

  /** Load logs/runs/ from the dev server into the viewer (new runs replace old ones by name), in one update. */
  const reloadLogs = useCallback(() => getLogs().then(logs => {
    const list = latest.current.runs.slice();
    for (const l of logs) {
      let run: Run;
      try { run = parseRun(label(l.name), l.text); } catch { continue; } // e.g. no run_start yet
      const i = list.findIndex(r => r.name === run.name);
      if (i >= 0) list[i] = run; else list.push(run);
    }
    latest.current.runs = list;
    setRuns(list);
  }).catch(() => { /* static build */ }), []);

  // Real runs from logs/runs/, fetched from the dev server so new ones need no restart.
  useEffect(() => {
    reloadLogs().then(() => {
      // ?a= / ?b= may name a run that only exists on disk, so resolve them again now
      const now = latest.current.runs;
      const a = findRun(now, q.get('a')), b = findRun(now, q.get('b'));
      if (a >= 0 || b >= 0) setSel(prev => [a >= 0 ? a : prev[0], b >= 0 ? b : prev[1]]);
    });
  }, [reloadLogs]);

  // A run started from the form wrote more log lines: show it in its panel and follow the newest hop.
  const followed = useRef<string | null>(null);
  const onLive = (panel: 0 | 1, name: string, text: string) => {
    const u = upsert(name, text);
    if (!u) return;
    setSel(prev => (panel === 0 ? [u.index, prev[1]] : [prev[0], u.index]));
    setPlaying(false);
    const fresh = followed.current !== u.run.name;
    followed.current = u.run.name;
    if (fresh || u.run.M !== u.prevM) {
      setStep(u.run.M);
      setAnimStep(u.run.M > (fresh ? 0 : u.prevM) ? u.run.M : -1);
    }
  };

  const setPanelRun = (p: number, i: number) => setSel(prev => (p === 0 ? [i, prev[1]] : [prev[0], i]));
  /** Open a run from the Runs table: show its end state, and trace its template's marker if it has one. */
  const openRun = (index: number, panel: 0 | 1) => {
    const r = latest.current.runs[index];
    if (!r) return;
    if (panel === 1) setCompare(true);
    setPanelRun(panel, index);
    setPlaying(false); setStep(r.M); setAnimStep(-1);
    const m = markerFor(r);
    if (m) setMarker(m);
    setTab('replay');
  };

  /** Put the clean twin of the attacked run in panel A next to it in panel B and show what the payload changed. */
  const startDiff = () => {
    const all = latest.current.runs;
    const a = all[sel[0]];
    if (!a) return;
    if (!a.start.template_id) {
      setNote({ text: 'Panel A shows a clean run. Put an attacked run in panel A, then diff it with its clean twin.', error: true });
      return;
    }
    const i = findClean(all, a);
    if (i < 0) {
      setMissingClean({ topology: a.topology, docId: String(a.start.doc_id), seed: Number(a.start.seed), model: String(a.start.model) });
      setDiffOn(false);
      return;
    }
    setMissingClean(null);
    setCompare(true); setPanelRun(1, i); setDiffOn(true);
    setPlaying(false); setStep(Math.max(a.M, all[i].M)); setAnimStep(-1);
  };

  /** Run the missing clean twin (same pipeline, document, seed and model, no payload), then diff. */
  const runClean = async () => {
    const m = missingClean;
    if (!m) return;
    try {
      setCleanBusy('Starting the clean run…');
      const doc = (await getDocs()).find(d => idFromName(d.name) === m.docId);
      if (!doc) throw new Error(`Could not find the clean document "${m.docId}" under data/.`);
      const backend = m.model === 'stub' ? 'stub' : m.model.startsWith('claude') ? 'anthropic' : 'ollama';
      const fin = await runAndFollow({ topology: m.topology, backend, docText: doc.text, docId: m.docId, seed: m.seed },
        j => setCleanBusy(`Running the clean version… ${(j.elapsedMs / 1000).toFixed(0)} s`), { stopped: false });
      if (fin.state === 'failed') throw new Error(fin.error ?? 'the clean run failed');
      await reloadLogs();
      setCleanBusy(null);
      startDiff();
    } catch (e) {
      setCleanBusy(null);
      setNote({ text: `Clean run: ${(e as Error).message}`, error: true });
    }
  };

  /** Which loaded runs the diff compares: the one with a template is the attacked one. */
  const diffPair = (() => {
    if (!diffOn || !compare) return null;
    const x = runs[sel[0]], y = runs[sel[1]];
    if (!x || !y || x === y) return null;
    return !x.start.template_id && y.start.template_id ? { attacked: y, clean: x } : { attacked: x, clean: y };
  })();

  /** Open a run by its run id, loading it from disk first if the viewer hasn't seen it yet. */
  const openByName = async (name: string) => {
    let i = latest.current.runs.findIndex(r => r.name === name);
    if (i < 0) { await reloadLogs(); i = latest.current.runs.findIndex(r => r.name === name); }
    if (i >= 0) openRun(i, 0); else setNote({ text: `Could not find the log for ${name}.`, error: true });
  };

  /** Switch panel `p` to a loaded run of pipeline `topo`, preferring the same document and outcome. */
  const pickTopology = (p: number, topo: Topology) => {
    const here = runs[sel[p]];
    if (here.topology === topo) return;
    const same = runs.map((r, i) => ({ r, i })).filter(x => x.r.topology === topo);
    if (!same.length) { setNote({ text: `No loaded run of ${topo} yet.`, error: true }); return; }
    const best = same.find(x => x.r.start.doc_id === here.start.doc_id && x.r.leaked === here.leaked)
      ?? same.find(x => x.r.leaked === here.leaked) ?? same[0];
    setPanelRun(p, best.i);
  };

  return (
    <>
      <header>
        <h1>Agent pipeline lab</h1>
        <p className="sub">
          Build multi-agent pipelines, run them on a document, and replay what each agent said to the next. An attack
          succeeds if the canary reaches a <code>send_message</code> call. Replay keys: <kbd>Space</kbd> play/pause,{' '}
          <kbd>{'←'}</kbd>/<kbd>{'→'}</kbd> step, <kbd>Home</kbd> restart.
        </p>
      </header>

      <div className="tabs main-tabs" role="tablist" aria-label="Sections">
        {([['replay', 'Run & replay'], ['runs', `Runs (${runs.length})`], ['batch', 'Batch'], ['pipelines', 'Pipelines']] as const).map(([id, text]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{text}</button>
        ))}
      </div>

      <div hidden={tab !== 'runs'}>
        <RunsTable runs={runs} markerFor={markerFor} onOpen={openRun} />
      </div>

      <div hidden={tab !== 'batch'}>
        <BatchTab pipelines={pipelines} runs={runs} onRefresh={reloadLogs} onOpenRun={openByName} />
      </div>

      <div hidden={tab !== 'pipelines'}>
        <PipelineEditor pipelines={pipelines} available={pipelinesOk} onChanged={loadPipelines}
          onUse={id => { setRequested({ id, n: Date.now() }); setTab('replay'); }} />
      </div>

      <div hidden={tab !== 'replay'}>
      <RunForm pipelines={pipelines} requested={requested} onLive={onLive} onStartBoth={() => setCompare(true)}
        onNote={(text, error) => setNote({ text, error })} onMarker={setMarker} />

      <section className="controls" aria-label="Replay controls">
        <div className="row">
          <button type="button" onClick={() => jump(0)}>{'⏮'} Restart</button>
          <button type="button" onClick={() => jump(cur - 1)}>{'◀'} Back</button>
          <button type="button" className="primary" onClick={togglePlay}>
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button type="button" onClick={() => { pause(); go(cur + 1, true); }}>Next {'▶'}</button>
          <label className="scrub">Step
            <input type="range" min={0} max={max} value={cur} aria-describedby="step-label"
              onChange={e => jump(Number(e.target.value))} />
          </label>
          <span id="step-label" className="step-label">hop {cur} / {max}</span>
          <label>Speed
            <select value={speed} onChange={e => setSpeed(Number(e.target.value))}>
              {[0.5, 1, 2, 4].map(s => <option key={s} value={s}>{s}{'×'}</option>)}
            </select>
          </label>
        </div>
        <div className="row">
          <label className="grow">Marker phrase
            <input type="text" value={marker} onChange={e => setMarker(e.target.value)} autoComplete="off" spellCheck={false}
              placeholder="paste the payload's marker phrase to trace its spread" />
          </label>
          <button type="button" aria-pressed={compare} onClick={() => setCompare(c => !c)}>Compare two runs</button>
          <button type="button" aria-pressed={diffOn} disabled={!!cleanBusy}
            onClick={() => (diffOn ? setDiffOn(false) : startDiff())}
            title="Puts the matching clean run in panel B and shows what the payload changed in each agent's output">
            {diffOn ? 'Hide diff' : 'Diff with clean run'}
          </button>
          <button type="button" onClick={() => fileInput.current?.click()}>Load log{'…'}</button>
          <input ref={fileInput} type="file" accept=".jsonl,.json,.txt" multiple hidden
            onChange={e => { loadFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
        </div>
        <div className={'drop' + (dragOver ? ' over' : '')}>Drop <code>.jsonl</code> run logs anywhere on this page</div>
        <div id="msg" className={note.error ? 'error' : ''} role="status" aria-live="polite">{note.text}</div>
      </section>

      <main id="panels">
        {runs.length === 0
          ? <p className="hint">No logs bundled. Load a .jsonl run log above.</p>
          : visible.map(p => (
            <RunPanel key={p} index={p} run={runs[sel[p]]} runs={runs} step={cur} marker={marker} speed={speed}
              animStep={animStep} onPickRun={i => setPanelRun(p, i)} onPickTopology={t => pickTopology(p, t)}
              onJump={jump} />
          ))}
      </main>

      {missingClean && (
        <div className="banner progress" role="status">
          There is no clean run to compare with: <code>{missingClean.topology}</code> on <code>{missingClean.docId}</code>, seed{' '}
          {missingClean.seed}, model <code>{missingClean.model}</code>, with no attack template.{' '}
          <button type="button" onClick={runClean} disabled={!!cleanBusy}>{cleanBusy ?? 'Run it now'}</button>
          {missingClean.model.startsWith('claude') && !cleanBusy && <span className="hint"> (one Claude run: well under a cent)</span>}

        </div>
      )}
      {diffPair && <DiffView attacked={diffPair.attacked} clean={diffPair.clean} marker={marker} />}
      </div>
    </>
  );
}
