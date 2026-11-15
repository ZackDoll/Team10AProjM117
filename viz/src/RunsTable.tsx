import { useMemo, useState } from 'react';
import { summarize } from './parse';
import type { RunSummary } from './parse';
import type { Run } from './types';

interface Props {
  runs: Run[];
  /** the phrase to trace for a run (from its template), or '' */
  markerFor: (run: Run) => string;
  onOpen: (runIndex: number, panel: 0 | 1) => void;
}

interface Row { i: number; run: Run; s: RunSummary; template: string }
type Key = 'time' | 'name' | 'pipeline' | 'doc' | 'template' | 'position' | 'seed' | 'model' | 'leak' | 'report' | 'depth' | 'calls' | 'cost';

const COLS: { key: Key; label: string; get: (r: Row) => string | number | null }[] = [
  { key: 'time', label: 'Time', get: r => r.s.time },
  { key: 'pipeline', label: 'Pipeline', get: r => r.run.topology },
  { key: 'doc', label: 'Doc', get: r => String(r.run.start.doc_id ?? '') },
  { key: 'template', label: 'Template', get: r => r.template },
  { key: 'position', label: 'Pos', get: r => String(r.run.start.position ?? '') },
  { key: 'seed', label: 'Seed', get: r => Number(r.run.start.seed ?? 0) },
  { key: 'model', label: 'Model', get: r => String(r.run.start.model ?? '') },
  { key: 'leak', label: 'Leak', get: r => (r.s.leaked ? 1 : 0) },
  { key: 'report', label: 'Report sent', get: r => (r.s.reportSent ? 1 : 0) },
  { key: 'depth', label: 'Spread', get: r => r.s.depth },
  { key: 'calls', label: 'LLM calls', get: r => r.run.llmCalls },
  { key: 'cost', label: 'Cost', get: r => r.s.cost },
];

const when = (t: number | null) => t === null ? '-'
  : new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function RunsTable({ runs, markerFor, onOpen }: Props) {
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: 'time', dir: -1 });
  const [text, setText] = useState('');
  const [only, setOnly] = useState<Set<string>>(new Set());

  const rows: Row[] = useMemo(() => runs.map((run, i) => ({
    i, run, s: summarize(run, markerFor(run)), template: String(run.start.template_id ?? ''),
  })), [runs, markerFor]);

  const shown = useMemo(() => {
    const q = text.trim().toLowerCase();
    const get = COLS.find(c => c.key === sort.key)!.get;
    return rows
      .filter(r => !q || [r.run.name, r.run.topology, r.template, r.run.start.doc_id, r.run.start.model, r.run.start.position]
        .some(v => String(v ?? '').toLowerCase().includes(q)))
      .filter(r => (!only.has('leaked') || r.s.leaked) && (!only.has('attacked') || !!r.template)
        && (!only.has('clean') || !r.template) && (!only.has('noreport') || !r.s.reportSent))
      .sort((a, b) => {
        const x = get(a), y = get(b);
        if (x === y) return a.i - b.i;
        if (x === null) return 1;          // empty values sort last, whichever way
        if (y === null) return -1;
        return (x < y ? -1 : 1) * sort.dir;
      });
  }, [rows, text, only, sort]);

  const toggle = (k: string) => setOnly(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const attacked = shown.filter(r => r.template);
  const leaks = attacked.filter(r => r.s.leaked).length;

  return (
    <section className="runs-tab">
      <div className="row">
        <label className="grow">Filter
          <input type="text" value={text} onChange={e => setText(e.target.value)} placeholder="run, pipeline, doc, template, model…" spellCheck={false} />
        </label>
        {([['leaked', 'Leaked'], ['attacked', 'Attack runs'], ['clean', 'Clean runs'], ['noreport', 'No report sent']] as const).map(([k, l]) => (
          <button key={k} type="button" aria-pressed={only.has(k)} onClick={() => toggle(k)}>{l}</button>
        ))}
      </div>
      <p className="hint" role="status" aria-live="polite">
        {shown.length} of {rows.length} runs
        {attacked.length > 0 && <> {'·'} attack success in view: <strong>{leaks} of {attacked.length}</strong> ({Math.round(100 * leaks / attacked.length)}%)</>}
        {' · '}click a column to sort; open a run in panel A or B to replay it
      </p>
      <div className="table-wrap">
        <table className="runs">
          <thead>
            <tr>
              <th scope="col">Run</th>
              {COLS.map(c => (
                <th key={c.key} scope="col" aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" onClick={() => setSort(s => ({ key: c.key, dir: s.key === c.key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
                    {c.label}{sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
              ))}
              <th scope="col">Open</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(r => (
              <tr key={r.run.name} className={r.s.leaked ? 'leaked' : ''}>
                <td className="mono">{r.run.name}</td>
                <td>{when(r.s.time)}</td>
                <td>{r.run.topology}</td>
                <td>{String(r.run.start.doc_id ?? '')}</td>
                <td>{r.template || <span className="hint">none</span>}</td>
                <td>{String(r.run.start.position ?? '') || <span className="hint">-</span>}</td>
                <td>{String(r.run.start.seed ?? '')}</td>
                <td>{String(r.run.start.model ?? '')}</td>
                <td>{r.s.leaked ? <strong className="bad-text">{'⚠'} LEAK</strong> : 'no leak'}</td>
                <td>{r.s.reportSent ? '✓ sent' : <span className="warn-text">{'✗'} none</span>}</td>
                <td>{r.s.depth}</td>
                <td>{r.run.llmCalls}{r.run.cached ? <span className="hint"> ({r.run.cached} cached)</span> : null}</td>
                <td>{r.s.cost === null ? '-' : `$${r.s.cost.toFixed(4)}`}</td>
                <td className="nowrap">
                  <button type="button" onClick={() => onOpen(r.i, 0)} aria-label={`Open ${r.run.name} in panel A`}>A</button>{' '}
                  <button type="button" onClick={() => onOpen(r.i, 1)} aria-label={`Open ${r.run.name} in panel B to compare`}>B</button>
                </td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={COLS.length + 2} className="hint">No runs match.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
