import { useEffect, useRef, useState } from 'react';
import type { Doc, JobState, RunRequest, Status, Template } from './api';
import { getDocs, getStatus, getTemplates, idFromName, previewInject, runAndFollow } from './api';
import { Highlight } from './Highlight';
import type { PipelineSpec } from './types';

interface Props {
  /** every saved pipeline (presets first) */
  pipelines: PipelineSpec[];
  /** the Pipelines tab asks for this pipeline to be picked; `n` changes on every request */
  requested: { id: string; n: number } | null;
  /** A run's log grew. panel 0 = A, 1 = B. */
  onLive: (panel: 0 | 1, logName: string, text: string) => void;
  onStartBoth: () => void;
  onNote: (text: string, error: boolean) => void;
  /** a run with a template was started: trace this template's marker phrase */
  onMarker: (marker: string) => void;
}

const money = (x: number) => `$${x.toFixed(4)}`;

export function RunForm({ pipelines, requested, onLive, onStartBoth, onNote, onMarker }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [docName, setDocName] = useState('');
  const [docText, setDocText] = useState('');
  const [docId, setDocId] = useState('');
  const [pipelineId, setPipelineId] = useState('chain');
  const [compareId, setCompareId] = useState(''); // '' = run just one pipeline
  const [backend, setBackend] = useState<'anthropic' | 'stub' | 'ollama'>('anthropic');
  const [seed, setSeed] = useState(1);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [tplId, setTplId] = useState('');      // a template to inject; '' = send the text as it is
  const [label, setLabel] = useState('');      // only for a payload you pasted into the text yourself
  const [position, setPosition] = useState<RunRequest['position']>('');
  const [preview, setPreview] = useState<{ text: string } | { error: string } | null>(null);
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
    getTemplates().then(setTemplates).catch(e => onNote(`Attack templates: ${(e as Error).message}`, true));
    return () => { stop.current.stopped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (requested) { setPipelineId(requested.id); setCompareId(''); }
  }, [requested]);

  // Show the document as it will be sent, payload inserted (done by the Python the run itself uses).
  useEffect(() => {
    if (!tplId || !position) { setPreview(null); return; }
    let live = true;
    const t = setTimeout(() => {
      previewInject(docText, tplId, position)
        .then(r => { if (live) setPreview(r.ok ? { text: r.text ?? '' } : { error: r.error ?? 'could not inject' }); })
        .catch(e => { if (live) setPreview({ error: (e as Error).message }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [tplId, position, docText]);

  const tpl = templates.find(t => t.id === tplId);
  const pickTemplate = (id: string) => {
    setTplId(id);
    if (id && !position) setPosition('middle');
  };

  const nameOf = (id: string) => pipelines.find(p => p.id === id)?.name || id;

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
    const topologies = compareId && compareId !== pipelineId ? [pipelineId, compareId] : [pipelineId];
    if (topologies.length > 1) onStartBoth();
    if (tpl?.marker) onMarker(tpl.marker); // so the spread of this payload is traced as the run plays
    let total = 0;
    try {
      for (let k = 0; k < topologies.length; k++) {
        const t = topologies[k];
        const panel = k as 0 | 1;
        setBusy(`Starting ${t} run…`);
        const req: RunRequest = tplId
          ? { topology: t, backend, docText, docId, seed, templateId: tplId, position, inject: true }
          : { topology: t, backend, docText, docId, seed, templateId: label.trim() || undefined, position };
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
          <label>Pipeline
            <select value={pipelineId} onChange={e => setPipelineId(e.target.value)} disabled={!!busy}>
              {pipelines.map(p => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
              {!pipelines.some(p => p.id === pipelineId) && <option value={pipelineId}>{pipelineId}</option>}
            </select>
          </label>
          <label>Also run <span className="hint">(side by side)</span>
            <select value={compareId} onChange={e => setCompareId(e.target.value)} disabled={!!busy}>
              <option value="">nothing else</option>
              {pipelines.filter(p => p.id !== pipelineId).map(p => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
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
          <label>Attack template
            <select value={tplId} onChange={e => pickTemplate(e.target.value)} disabled={!!busy || !templates.length}>
              <option value="">none: send the text as it is</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.id}{t.technique ? ` (${t.technique.slice(0, 40)})` : ''}</option>)}
            </select>
          </label>
          <label>Position
            <select value={position} onChange={e => setPosition(e.target.value as RunRequest['position'])} disabled={!!busy}>
              {!tplId && <option value="">n/a</option>}
              <option value="start">start</option><option value="middle">middle</option><option value="end">end</option>
            </select>
          </label>
          {!tplId && (
            <label>Label <span className="hint">(for a payload you pasted)</span>
              <input type="text" value={label} onChange={e => setLabel(e.target.value)} disabled={!!busy}
                size={12} placeholder="optional" spellCheck={false} />
            </label>
          )}
        </div>
        <label>Document text {edited ? <span className="hint">(edited)</span>
          : <span className="hint">(the clean document; edit freely, or paste a payload yourself and give it a label)</span>}
          <textarea value={docText} onChange={e => setDocText(e.target.value)} disabled={!!busy} rows={tplId ? 5 : 7} spellCheck={false} />
        </label>
        {tplId && (
          <details className="inject-preview" open>
            <summary>Document as it will be sent, with <code>{tplId}</code> inserted at the {position}
              {tpl?.marker ? <> {'·'} traces <code>{tpl.marker}</code></> : null}</summary>
            {preview && 'error' in preview
              ? <div className="error">{preview.error}</div>
              : <pre className="content">{preview ? <Highlight text={preview.text} marker={tpl?.text.trim()} /> : 'Loading…'}</pre>}
          </details>
        )}
        <div className="row">
          <button type="button" className="primary" onClick={run} disabled={disabled}>
            {busy ? 'Running…' : `▶ Run ${nameOf(pipelineId)}${compareId && compareId !== pipelineId ? ` + ${nameOf(compareId)}` : ''}`}
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
        <p className="hint small">Runs with the same pipeline, doc id, template, position, seed and model replace each other's log; a different model gets its own.
          The API key stays in the local server; the browser never sees it.</p>
      </div>
    </details>
  );
}
