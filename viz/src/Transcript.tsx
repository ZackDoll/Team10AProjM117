import { useEffect, useMemo, useRef, useState } from 'react';
import { Highlight } from './Highlight';
import { buildTranscript, renderMarkdown, transcriptFileName } from './transcriptData';
import type { Run } from './types';

interface Props {
  run: Run;
  marker: string;
  /** the replay's current step, so the matching card is marked and scrolled to */
  step: number;
  onJump: (step: number) => void;
}

export function Transcript({ run, marker, step, onJump }: Props) {
  const t = useMemo(() => buildTranscript(run.events), [run]);
  const md = useMemo(() => renderMarkdown(t), [t]);
  const [copied, setCopied] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const cards = useRef<Record<number, HTMLElement | null>>({});

  // Keep the card for the current replay step in view without scrolling the whole page.
  useEffect(() => {
    const c = box.current, el = cards.current[step];
    if (c && el) c.scrollTo({ top: Math.max(0, el.offsetTop - 8), behavior: 'auto' });
  }, [step, run]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(md); setCopied('Copied'); }
    catch { setCopied('Copy failed: select the text and copy it by hand'); }
    setTimeout(() => setCopied(null), 2500);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = transcriptFileName(t); a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="transcript">
      <div className="t-bar">
        <button type="button" onClick={copy}>Copy as markdown</button>
        <button type="button" onClick={download}>Download .md</button>
        <span className="hint" role="status" aria-live="polite">
          {copied ?? <>Every run also saves this to <code>logs/transcripts/{t.runId}.md</code></>}
        </span>
      </div>

      <div ref={box} className="t-scroll">
        <details className="t-prompts">
          <summary>System prompts ({t.nodes.length || 'not recorded in this log'})</summary>
          {t.nodes.map(n => (
            <div key={n.id} className="t-prompt">
              <h4>{n.label} <code>{n.id}</code> <span className="hint">{n.type}</span>
                {n.holds && <span className="badge hit">holds the canary</span>}</h4>
              {n.type === 'hub' && <div className="hint">Relays to, in order: {n.spokes.join(', ')}</div>}
              <pre className="content"><Highlight text={n.prompt} canary={t.canary} marker={marker} /></pre>
            </div>
          ))}
          {!t.hasPrompts && <p className="hint">This log was written before logs recorded their pipeline, so the
            prompts are unknown. Re-run it to capture them.</p>}
        </details>

        {t.steps.map(s => (
          <article key={s.n} ref={el => { cards.current[s.n] = el; }}
            className={'t-step' + (s.n === step ? ' current' : '') + (s.n > step ? ' future' : '')}>
            <h4>
              <button type="button" onClick={() => onJump(s.n)} aria-current={s.n === step ? 'step' : undefined}>
                Step {s.n} {'·'} {s.sender} {'→'} {s.receiver}
              </button>
            </h4>
            <pre className="content"><Highlight text={s.content} canary={t.canary} marker={marker} /></pre>
            {s.items.map((x, i) => x.kind === 'call' ? (
              <div key={i} className="t-call">
                <div className={'ev tool' + (x.leak ? ' bad' : '')}>
                  <span className="tag">{x.tool}</span>{x.caller} {'→'} <code>{x.to}</code>
                  {x.leak && <strong> {'⚠'} LEAK: contains the canary</strong>}
                </div>
                <pre className="content"><Highlight text={x.body} canary={t.canary} marker={marker} /></pre>
              </div>
            ) : (
              <div key={i} className="ev bad"><span className="tag">error</span>{x.agent}: {x.errorKind}
                {x.detail && <pre className="content">{x.detail}</pre>}</div>
            ))}
          </article>
        ))}
        {t.preErrors.map((x, i) => (
          <div key={i} className="ev bad"><span className="tag">error</span>before the first message: {x.errorKind}
            {x.detail && <pre className="content">{x.detail}</pre>}</div>
        ))}

        <section className={'t-final' + (step >= t.steps.length ? '' : ' future')}>
          <h4>Final output</h4>
          {t.final ? (
            <>
              <div className="hint">
                {t.final.step !== null
                  ? <>From <strong>{t.final.sender}</strong> (step {t.final.step}: {t.final.sender} {'→'} {t.final.receiver})</>
                  : <>From pipeline output node <code>{t.final.outNode || '?'}</code> (not delivered as a message)</>}
                {t.final.step !== null && t.final.outNode ? <> {'·'} output node <code>{t.final.outNode}</code></> : null}
              </div>
              <pre className="content"><Highlight text={t.final.text} canary={t.canary} marker={marker} /></pre>
            </>
          ) : <p className="hint">No final output was produced.</p>}
        </section>
      </div>
    </div>
  );
}
