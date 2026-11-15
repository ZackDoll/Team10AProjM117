// Client for the dev-server API in ../server/runApi.ts. Under a static build these endpoints
// don't exist, and every function here fails quietly so the viewer still replays logs.
import type { PipelineSpec } from './types';

export interface Status {
  python: string; hasKey: boolean; model: string; config: string;
  sessionSpentUsd: number; running: string | null; batchRunning: string | null;
  ollamaModel: string; ollamaHost: string; ollamaReachable: boolean;
}
export interface Doc { name: string; text: string }
export interface SpecCheck { ok: boolean; errors: string[]; warnings: string[] }
export interface Template { id: string; text: string; technique?: string; marker?: string }
export interface RunRequest {
  /** a saved pipeline's id (pipelines/<id>.json or pipelines/custom/<id>.json) */
  topology: string;
  backend: 'anthropic' | 'stub' | 'ollama';
  docText: string; docId: string; seed: number;
  /** with `inject`, a template from data/attacks/templates.json whose payload is inserted for you;
   *  without it, just a label for a payload you pasted into the text yourself */
  templateId?: string; position?: '' | 'start' | 'middle' | 'end'; inject?: boolean;
}
export interface JobState {
  state: 'running' | 'done' | 'failed';
  error: string | null; spentUsd: number; sessionSpentUsd: number; elapsedMs: number;
  log: string; logName: string | null;
}

/** A model name made safe for a file name, as in a run id: qwen2.5:3b-instruct -> qwen2.5-3b-instruct.
 *  Must match model_slug() in src/m117/pipeline.py (`npm run test:slug`). */
export const modelSlug = (m: string) => m.replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';

/** A document's run id: data/placeholder/d1.txt -> d1 */
export const idFromName = (n: string) => n.replace(/\.txt$/, '').split('/').pop()!.replace(/[^A-Za-z0-9_.-]/g, '_');

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: 'no-store' });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new Error('no run API (static build?)');
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body as T;
}

async function sendJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data as T;
}

export interface BatchRequest {
  pipelines: string[]; docs: string[]; templateIds: string[]; positions: string[]; seeds: number[];
  withClean: boolean; backend: 'anthropic' | 'stub' | 'ollama'; maxRuns: number;
}
export interface BatchRow {
  i: number; run_id: string; pipeline: string; doc: string; template: string | null; position: string | null; seed: number;
  leaked?: boolean; leaked_to?: string | null; report_sent?: boolean; status?: string; cost_usd?: number | null; error?: string;
}
export interface BatchState {
  state: 'running' | 'done' | 'failed' | 'stopped'; total: number; rows: BatchRow[]; current: string | null; overwrites: string[];
  error: string | null; spentUsd: number; model: string | null; elapsedMs: number;
  summary: { ran: number; attack_runs: number; leaks: number; spent_usd: number } | null;
}
export const startBatch = (req: BatchRequest) => sendJson<{ job: string }>('POST', './api/batch', req);
export const getBatch = (id: string) => getJson<BatchState>(`./api/batch/${id}`);
export const stopBatch = (id: string) => sendJson<{ state: string }>('POST', `./api/batch/${id}/stop`, {});

export const getTemplates = () => getJson<Template[]>('./api/templates');
export const previewInject = (doc: string, templateId: string, position: string) =>
  sendJson<{ ok: boolean; text?: string; marker?: string; error?: string }>('POST', './api/inject', { doc, templateId, position });

export const getPipelines = () => getJson<PipelineSpec[]>('./api/pipelines');
export const validatePipeline = (spec: PipelineSpec) => sendJson<SpecCheck>('POST', './api/pipelines/validate', spec);
export const savePipeline = (spec: PipelineSpec) =>
  sendJson<{ saved: string; warnings: string[] }>('POST', './api/pipelines', spec);
export const deletePipeline = (id: string) => sendJson<{ deleted: string }>('DELETE', `./api/pipelines/${encodeURIComponent(id)}`);

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
