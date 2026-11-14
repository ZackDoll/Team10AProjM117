import type { Analysis } from './parse';
import { isLeakCall, stepForEvent } from './parse';
import type { Run } from './types';

export function Timeline({ run, a, onJump }: { run: Run; a: Analysis; onJump: (step: number) => void }) {
  const winStart = a.s >= 1 ? run.msgIdx[a.s - 1] : 0;
  return (
    <details className="timeline" open>
      <summary>Timeline (click an event to jump to it)</summary>
      <ol>
        {run.events.map((e, i) => {
          if (e.event === 'run_start') return null;
          let label: string = e.event;
          if (e.event === 'message') label = `${e.sender} → ${e.receiver}`;
          else if (e.event === 'llm_call') label = `${e.agent}${e.cached ? ' (cached)' : ''}`;
          else if (e.event === 'tool_call') label = `${e.caller || 'tool_user'}: ${e.tool} to ${e.args?.to ?? '?'}`;
          else if (e.event === 'run_end') label = `status ${e.status}`;
          const leak = isLeakCall(run, e);
          const cls = [i > a.end ? 'future' : '', i >= winStart && i <= a.end ? 'current' : '', leak ? 'leak' : '']
            .filter(Boolean).join(' ');
          return (
            <li key={i}>
              <button type="button" className={cls} onClick={() => onJump(stepForEvent(run, i))}
                aria-current={e.event === 'message' && i === winStart && a.s >= 1 ? 'step' : undefined}>
                <span className="tag">{e.event}</span>{label}{leak ? ' ⚠ canary' : ''}
              </button>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
