import { useEffect, useRef, useState } from 'react';
import type { Doc, JobState, RunRequest, Status } from './api';
import { getDocs, getStatus, runAndFollow } from './api';

type TopoChoice = 'chain' | 'orchestrator' | 'both';

interface Props {
  /** A run's log grew. panel 0 = A, 1 = B. */
  onLive: (panel: 0 | 1, logName: string, text: string) => void;
  onStartBoth: () => void;
  onNote: (text: string, error: boolean) => void;
}

const idFromName = (n: string) => n.replace(/\.txt$/, '').split('/').pop()!.replace(/[^A-Za-z0-9_.-]/g, '_');
const money = (x: number) => `$${x.toFixed(4)}`;

export function RunForm({ onLive, onStartBoth, onNote }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [docName, setDocName] = useState('');
  const [docText, setDocText] = useState('');
  const [docId, setDocId] = useState('');
  const [topo, setTopo] = useState<TopoChoice>('chain');
  const [backend, setBackend] = useState<'anthropic' | 'stub' | 'ollama'>('anthropic');
  const [seed, setSeed] = useState(1);
  const [templateId, setTemplateId] = useState('');
  const [position, setPosition] = useState<RunRequest['position']>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [lastSpend, setLastSpend] = useState<number | null>(null);
  const stop = useRef({ stopped: false });

  useEffect(() => {
    stop.current = { stopped: false }; // StrictMode mounts twice; the first cleanup must not stick
    getStatus().then(setStatus).catch(e => setApiError((e as Error).message));
    getDocs().then(d => {
      setDocs(d);
      const first = d.find(x => x.name.endsWith('d1.txt')) ?? d[0];
      if (first) { setDocName(first.name); setDocText(first.text); setDocId(idFromName(first.name)); }
    }).catch(() => {});
    return () => { stop.current.stopped = true; };
  }, []);

  const pickDoc = (name: string) => {
    const d = docs.find(x => x.name === name);
    setDocName(name);
    if (d) { setDocText(d.text); setDocId(idFromName(d.name)); }
  };
  const original = docs.find(x => x.name === docName)?.text;
  const edited = original !== undefined && original !== docText;

  if (apiError) {
    return (
      <details className="runform">
        <summary>New run (unavailable)</summary>
        <p className="hint">Starting runs needs the dev server: <code>cd viz && npm run dev</code>. This page is
          only replaying bundled logs.</p>
      </details>
    );
  }

  const run = async () => {
    const topologies: ('chain' | 'orchestrator')[] = topo === 'both' ? ['chain', 'orchestrator'] : [topo];
    if (topo === 'both') onStartBoth();
    let total = 0;
    try {
      for (let k = 0; k < topologies.length; k++) {
        const t = topologies[k];
        const panel = (topo === 'both' ? k : 0) as 0 | 1;
        setBusy(`Starting ${t} run…`);
        const req: RunRequest = { topology: t, backend, docText, docId, seed,
          templateId: templateId.trim() || undefined, position };
        const modelLabel = backend === 'anthropic' ? status?.model : backend === 'ollama' ? status?.ollamaModel : 'stub';
        const fin: JobState = await runAndFollow(req, j => {
          const events = j.log ? j.log.split('\n').filter(Boolean).length : 0;
          setBusy(`Running ${t} (${modelLabel}): ${(j.elapsedMs / 1000).toFixed(0)} s, ${events} events logged`);
          if (j.log && j.logName) onLive(panel, j.logName, j.log);
        }, stop.current);
        total += fin.spentUsd;
        setStatus(s => (s ? { ...s, sessionSpentUsd: fin.sessionSpentUsd } : s));
        if (fin.state === 'failed') {
          onNote(`${t} run failed: ${fin.error ?? 'unknown error'}`, true);
          return;
        }
      }
      setLastSpend(total);
      onNote(`Finished ${topologies.join(' + ')} run${topologies.length > 1 ? 's' : ''}. Cost ${money(total)}` +
        (total === 0 && backend === 'anthropic' ? ' (all answers came from the cache)' : ''), false);
    } catch (e) {
      onNote(`Run failed: ${(e as Error).message}`, true);
    } finally {
      setBusy(null);
    }
  };

  const keyMissing = backend === 'anthropic' && status && !status.hasKey;
  const ollamaDown = backend === 'ollama' && status && !status.ollamaReachable;
  const disabled = !!busy || !docText.trim() || !docId || !!keyMissing || !!ollamaDown;

  return (
    <details className="runform" open>
      <summary>New run{status ? <span className="hint"> · model {status.model} · spent this session {money(status.sessionSpentUsd)}</span> : null}</summary>
      <div className="runform-body">
        <div className="row">
          <label>Document
            <select value={docName} onChange={e => pickDoc(e.target.value)} disabled={!!busy}>
              {docs.map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
            </select>
          </label>
          <label>Doc id
            <input type="text" value={docId} onChange={e => setDocId(e.target.value)} disabled={!!busy}
              size={18} spellCheck={false} />
          </label>
          <label>Topology
            <select value={topo} onChange={e => setTopo(e.target.value as TopoChoice)} disabled={!!busy}>
              <option value="chain">chain</option>
              <option value="orchestrator">orchestrator</option>
              <option value="both">both (compare side by side)</option>
            </select>
          </label>
          <label>Backend
            <select value={backend} onChange={e => setBackend(e.target.value as 'anthropic' | 'stub' | 'ollama')} disabled={!!busy}>
              <option value="anthropic">Claude ({status?.model ?? 'from config'})</option>
              <option value="ollama">
                Local: {status?.ollamaModel ?? 'from config'}{status && !status.ollamaReachable ? ' (not running)' : ''}
              </option>
              <option value="stub">stub (free, no API)</option>
            </select>
          </label>
          <label>Seed
            <input type="number" min={0} value={seed} onChange={e => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              disabled={!!busy} style={{ width: '6em' }} />
          </label>
          <label>Template id
            <input type="text" value={templateId} onChange={e => setTemplateId(e.target.value)} disabled={!!busy}
              size={12} placeholder="optional" spellCheck={false} />
          </label>
          <label>Position
            <select value={position} onChange={e => setPosition(e.target.value as RunRequest['position'])} disabled={!!busy}>
              <option value="">n/a</option><option value="start">start</option>
              <option value="middle">middle</option><option value="end">end</option>
            </select>
          </label>
        </div>
        <label>Document text {edited ? <span className="hint">(edited: paste a payload here to test an attack)</span>
          : <span className="hint">(edit freely: paste a payload here to test an attack)</span>}
          <textarea value={docText} onChange={e => setDocText(e.target.value)} disabled={!!busy} rows={7} spellCheck={false} />
        </label>
        <div className="row">
          <button type="button" className="primary" onClick={run} disabled={disabled}>
            {busy ? 'Running…' : `▶ Run ${topo === 'both' ? 'both topologies' : topo}`}
          </button>
          <span className="hint" role="status" aria-live="polite">
            {keyMissing ? 'No ANTHROPIC_API_KEY in .env. Add it, or use the stub backend.'
              : ollamaDown ? `Can't reach Ollama at ${status?.ollamaHost}. Install it, run \`ollama serve\`, ` +
                `and \`ollama pull ${status?.ollamaModel}\` (see docs/OLLAMA.md).`
              : busy ?? (lastSpend !== null ? `Last run cost ${money(lastSpend)}.` :
                backend === 'ollama' ? 'Local model: free, no rate limit, and much weaker at resisting injection.'
                : 'Each Haiku run takes ~15-40 s and costs well under a cent. Same doc text + seed is answered from the cache for free.')}
          </span>
        </div>
        <p className="hint small">Runs with the same topology, doc id, template, position and seed overwrite each other's log file.
          The API key stays in the local server; the browser never sees it.</p>
      </div>
    </details>
  );
}
