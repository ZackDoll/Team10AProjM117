// Client for the dev-server API in ../server/runApi.ts. Under a static build these endpoints
// don't exist, and every function here fails quietly so the viewer still replays logs.

export interface Status {
  python: string; hasKey: boolean; model: string; config: string;
  sessionSpentUsd: number; running: string | null;
  ollamaModel: string; ollamaHost: string; ollamaReachable: boolean;
}
export interface Doc { name: string; text: string }
export interface RunRequest {
  topology: 'chain' | 'orchestrator';
  backend: 'anthropic' | 'stub' | 'ollama';
  docText: string; docId: string; seed: number;
  templateId?: string; position?: '' | 'start' | 'middle' | 'end';
}
export interface JobState {
  state: 'running' | 'done' | 'failed';
  error: string | null; spentUsd: number; sessionSpentUsd: number; elapsedMs: number;
  log: string; logName: string | null;
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: 'no-store' });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new Error('no run API (static build?)');
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body as T;
}

export const getStatus = () => getJson<Status>('./api/status');
export const getDocs = () => getJson<Doc[]>('./api/docs');
export const getLogs = () => getJson<Doc[]>('./api/logs');
export const getJob = (id: string) => getJson<JobState>(`./api/run/${id}`);

export async function startRun(req: RunRequest): Promise<string> {
  const r = await fetch('./api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body.job as string;
}

/** Start a run and call onUpdate with the growing log until it finishes. */
export async function runAndFollow(req: RunRequest, onUpdate: (j: JobState) => void,
                                   signal: { stopped: boolean }): Promise<JobState> {
  const id = await startRun(req);
  for (;;) {
    await new Promise(r => setTimeout(r, 500));
    const j = await getJob(id);
    if (!signal.stopped) onUpdate(j);
    if (j.state !== 'running') return j;
  }
}
