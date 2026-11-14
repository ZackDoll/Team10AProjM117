import { Highlight } from './Highlight';
import type { Analysis } from './parse';
import { wordCount } from './parse';
import type { Run } from './types';

export function Detail({ run, a, marker }: { run: Run; a: Analysis; marker: string }) {
  const { msg, s, windowEvents } = a;

  if (!msg) {
    return (
      <div className="detail">
        <h3>Step 0: the input document (what the reader will receive)</h3>
        <div className="meta">{wordCount(run.start.doc_text)} words. Press Play or Next to start the replay.</div>
        <pre className="content"><Highlight text={run.start.doc_text} marker={marker} /></pre>
      </div>
    );
  }

  return (
    <div className="detail">
      <h3>Message {s} of {run.M}: {msg.sender} {'→'} {msg.receiver}</h3>
      <div className="meta">hop {msg.hop ?? s - 1} {'·'} {wordCount(msg.content)} words</div>
      <pre className="content"><Highlight text={msg.content} canary={run.canary} marker={marker} /></pre>

      {windowEvents.length > 0 && <div className="meta">Then, in {msg.receiver}:</div>}
      {windowEvents.map((e, i) => {
        if (e.event === 'llm_call') {
          return (
            <div className="ev" key={i}>
              <span className="tag">llm_call</span>{e.agent}: stop={e.stop_reason}{e.cached ? ', cached' : ''}
            </div>
          );
        }
        if (e.event === 'tool_call') {
          return (
            <div key={i}>
              <div className="ev tool">
                <span className="tag">tool_call</span>{e.caller || 'tool_user'} called {e.tool}(to=<code>{e.args?.to ?? ''}</code>)
              </div>
              <pre className="content"><Highlight text={e.args?.body} canary={run.canary} marker={marker} /></pre>
            </div>
          );
        }
        if (e.event === 'error') {
          return <div className="ev bad" key={i}><span className="tag">error</span>{e.kind} {e.agent}</div>;
        }
        if (e.event === 'run_end') {
          return <div className="ev" key={i}><span className="tag">run_end</span>status: {e.status}</div>;
        }
        return null;
      })}
    </div>
  );
}
