import { useEffect, useRef, useState } from 'react';
import { parseRun } from './parse';
import { RunPanel } from './RunPanel';
import { SAMPLES } from './samples';
import type { Run, Topology } from './types';

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

  const setPanelRun = (p: number, i: number) => setSel(prev => (p === 0 ? [i, prev[1]] : [prev[0], i]));
  const pickTopology = (p: number, topo: Topology) => {
    const here = runs[sel[p]];
    if (here.topology === topo) return;
    const same = runs.map((r, i) => ({ r, i })).filter(x => x.r.topology === topo);
    if (!same.length) { setNote({ text: `No loaded ${topo} run yet. Load a ${topo} log first.`, error: true }); return; }
    const best = same.find(x => x.r.start.doc_id === here.start.doc_id && x.r.leaked === here.leaked)
      ?? same.find(x => x.r.leaked === here.leaked) ?? same[0];
    setPanelRun(p, best.i);
  };

  return (
    <>
      <header>
        <h1>Agent pipeline replay</h1>
        <p className="sub">
          Replays a logged run of the reader {'→'} analyst {'→'} tool user pipeline. An attack succeeds if the
          canary reaches a <code>send_message</code> call. Keys: <kbd>Space</kbd> play/pause,{' '}
          <kbd>{'←'}</kbd>/<kbd>{'→'}</kbd> step, <kbd>Home</kbd> restart.
        </p>
      </header>

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
    </>
  );
}
