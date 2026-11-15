// Dev-server API that lets the viewer start real pipeline runs.
//
// The browser never sees the API key: it asks this local server to run
// `python scripts/run_one.py --json ...`, the Python side reads ANTHROPIC_API_KEY from .env, and
// this server streams the growing JSONL log back as the run progresses. backend: "ollama" runs
// against a local model through Ollama instead (config/local.yaml, no key needed).
//
//   GET  /api/status        python path, key/Ollama availability, models, session spend
//   GET  /api/docs          .txt documents under data/ (name + text), for the document picker
//   GET  /api/templates     attack payload templates (data/attacks/templates.json)
//   GET  /api/manifest      data/docs/manifest.json: each document's length tier and assigned poison
//   POST /api/inject        {doc, templateId, position} -> the document with the payload inserted (preview)
//   GET/POST/DELETE /api/pipelines[/<id>], POST /api/pipelines/validate   the pipeline builder
//   POST /api/batch         start scripts/run_batch.py; GET /api/batch/<job> progress; POST /api/batch/<job>/stop
//   GET  /api/logs          every log in logs/runs/ (so new runs show up without a restart)
//   POST /api/run           start a run; body {topology, docText, docId, seed, backend, templateId?, position?}
//   GET  /api/run/<job>     {state, log, error, spentUsd}; poll this while the run is going
//
// Only exists under `npm run dev`. A static build (`npm run build`) has no API and just replays logs.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

const ROOT = resolve(import.meta.dirname, '..', '..');
const RUNS_DIR = join(ROOT, 'logs', 'runs');
const DATA_DIR = join(ROOT, 'data');
const PIPELINES_DIR = join(ROOT, 'pipelines');          // built-in presets (read-only here)
const CUSTOM_DIR = join(PIPELINES_DIR, 'custom');        // pipelines saved from the editor
const CONFIG_FOR: Record<string, string> = { anthropic: 'config/dev.yaml', stub: 'config/dev.yaml',
  ollama: 'config/local.yaml' };

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/; // goes into a file name, so keep it boring
const MAX_DOC_CHARS = 200_000;

interface Job {
  id: string;
  state: 'running' | 'done' | 'failed';
  logPath: string | null;
  error: string | null;
  spentUsd: number;
  stderr: string;
  startedAt: number;
}

interface BatchJob {
  id: string;
  state: 'running' | 'done' | 'failed' | 'stopped';
  total: number;
  /** one entry per finished run (the batch script's "run" events) */
  rows: Record<string, unknown>[];
  /** the run id being worked on right now */
  current: string | null;
  overwrites: string[];
  error: string | null;
  spentUsd: number;
  summary: Record<string, unknown> | null;
  model: string | null;
  stderr: string;
  startedAt: number;
  child: ChildProcess | null;
}

function pythonPath(): string {
  for (const p of [join(ROOT, '.venv', 'Scripts', 'python.exe'), join(ROOT, '.venv', 'bin', 'python')])
    if (existsSync(p)) return p;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** True if an API key is configured. Only checks presence; the value is never read into a response. */
function hasKey(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  const env = join(ROOT, '.env');
  if (!existsSync(env)) return false;
  return /^\s*ANTHROPIC_API_KEY\s*=\s*["']?[^\s"'#]+/m.test(readFileSync(env, 'utf8'));
}

function readYamlField(path: string, field: string): string | null {
  try {
    const m = readFileSync(join(ROOT, path), 'utf8').match(new RegExp(`^${field}:\\s*([^\\s#]+)`, 'm'));
    return m ? m[1] : null;
  } catch { return null; }
}

/** Ollama has no API key; "configured" just means the server answers. Short timeout: this must
 *  not make /api/status hang when Ollama isn't installed or running. */
async function ollamaReachable(host: string): Promise<boolean> {
  try {
    const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch { return false; }
}

interface SpecCheck { ok: boolean; errors: string[]; warnings: string[] }

/** The one validator: scripts/validate_pipeline.py, the same code the runner uses. */
function validateSpec(text: string): Promise<SpecCheck> {
  return new Promise(done => {
    const child = spawn(pythonPath(), [join('scripts', 'validate_pipeline.py'), '-'], {
      cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true,
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { out += c; });
    child.on('error', e => done({ ok: false, errors: [`could not start Python: ${e.message}`], warnings: [] }));
    child.on('close', () => {
      try { done(JSON.parse(out.trim().split('\n').pop() ?? '')); }
      catch { done({ ok: false, errors: ['the validator produced no result'], warnings: [] }); }
    });
    child.stdin.end(text, 'utf8');
  });
}

/** Run a small Python script with JSON on stdin and read one JSON object from its last stdout line. */
function pyJson<T>(script: string, input: unknown): Promise<T> {
  return new Promise((done, fail) => {
    const child = spawn(pythonPath(), [join('scripts', script)], {
      cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true,
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { out += c; });
    child.on('error', e => fail(new Error(`could not start Python: ${e.message}`)));
    child.on('close', () => {
      try { done(JSON.parse(out.trim().split('\n').pop() ?? '')); }
      catch { fail(new Error(`${script} produced no result`)); }
    });
    child.stdin.end(JSON.stringify(input), 'utf8');
  });
}

/** Every pipeline file: presets first (chain, orchestrator), then custom ones alphabetically. */
function listPipelines() {
  const out: any[] = [];
  for (const [dir, builtin] of [[PIPELINES_DIR, true], [CUSTOM_DIR, false]] as const) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
      try { out.push({ ...JSON.parse(readFileSync(join(dir, f), 'utf8')), builtin }); } catch { /* skip unreadable */ }
    }
  }
  const rank = (s: any) => (s.builtin ? (s.id === 'chain' ? 0 : s.id === 'orchestrator' ? 1 : 2) : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

const pipelineExists = (id: string) =>
  ID_RE.test(id) && [PIPELINES_DIR, CUSTOM_DIR].some(d => existsSync(join(d, `${id}.json`)));
const isBuiltinId = (id: string) => ID_RE.test(id) && existsSync(join(PIPELINES_DIR, `${id}.json`));

function listTxt(dir: string, out: { name: string; text: string }[] = []) {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) listTxt(p, out);
    else if (f.endsWith('.txt')) out.push({ name: relative(DATA_DIR, p).split(sep).join('/'), text: readFileSync(p, 'utf8') });
  }
  return out;
}

function send(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', c => { s += c; if (s.length > MAX_DOC_CHARS * 2) { fail(new Error('body too large')); req.destroy(); } });
    req.on('end', () => ok(s));
    req.on('error', fail);
  });
}

/** Reject requests from other web pages (a site you visit must not be able to spend your credits). */
function sameOrigin(req: import('node:http').IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return req.method === 'GET';
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export function runApi(): Plugin {
  const jobs = new Map<string, Job>();
  let active: Job | null = null;
  let activeBatch: BatchJob | null = null;
  const batches = new Map<string, BatchJob>();
  let sessionSpent = 0;
  let nextId = 1;

  return {
    name: 'm117-run-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin request refused' });
        try {
          if (req.method === 'GET' && url.pathname === '/status') {
            const ollamaHost = readYamlField(CONFIG_FOR.ollama, 'ollama_host') || 'http://localhost:11434';
            return send(res, 200, {
              python: pythonPath(), hasKey: hasKey(), model: readYamlField(CONFIG_FOR.anthropic, 'model') || '?',
              config: CONFIG_FOR.anthropic, sessionSpentUsd: sessionSpent, running: active?.id ?? null, batchRunning: activeBatch?.id ?? null,
              ollamaModel: readYamlField(CONFIG_FOR.ollama, 'model') || '?', ollamaHost,
              ollamaReachable: await ollamaReachable(ollamaHost),
            });
          }
          if (req.method === 'GET' && url.pathname === '/docs') return send(res, 200, listTxt(DATA_DIR));
          if (req.method === 'GET' && url.pathname === '/logs') {
            const logs = existsSync(RUNS_DIR)
              ? readdirSync(RUNS_DIR).filter(f => f.endsWith('.jsonl'))
                .map(f => ({ name: f, text: readFileSync(join(RUNS_DIR, f), 'utf8') }))
              : [];
            return send(res, 200, logs);
          }
          if (req.method === 'GET' && url.pathname === '/manifest') {
            // per-document facts for data/docs: length tier and the assigned poison (a template and a position)
            const mp = join(DATA_DIR, 'docs', 'manifest.json');
            return send(res, 200, existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : []);
          }
          if (req.method === 'GET' && url.pathname === '/templates') {
            try { return send(res, 200, JSON.parse(readFileSync(join(DATA_DIR, 'attacks', 'templates.json'), 'utf8'))); }
            catch (e) { return send(res, 500, { error: `data/attacks/templates.json: ${(e as Error).message}` }); }
          }
          if (req.method === 'POST' && url.pathname === '/inject') {
            const b = JSON.parse(await readBody(req));
            return send(res, 200, await pyJson('inject_doc.py', {
              doc: String(b.doc ?? ''), template_id: String(b.templateId ?? ''), position: String(b.position ?? ''),
            }));
          }
          if (req.method === 'GET' && url.pathname === '/pipelines') return send(res, 200, listPipelines());
          if (req.method === 'POST' && url.pathname === '/pipelines/validate') {
            return send(res, 200, await validateSpec(await readBody(req)));
          }
          if (req.method === 'POST' && url.pathname === '/pipelines') {
            if (req.headers['content-type']?.split(';')[0] !== 'application/json')
              return send(res, 415, { error: 'send JSON' });
            const text = await readBody(req);
            let spec: any;
            try { spec = JSON.parse(text); } catch { return send(res, 400, { error: 'not valid JSON' }); }
            if (typeof spec?.id !== 'string' || !ID_RE.test(spec.id))
              return send(res, 400, { error: 'id: letters, digits, _ . - only (max 64)' });
            if (isBuiltinId(spec.id))
              return send(res, 409, { error: `"${spec.id}" is a built-in preset and can't be overwritten. Save it under a new id.` });
            const check = await validateSpec(text);
            if (!check.ok) return send(res, 400, { error: check.errors.join('; '), ...check });
            mkdirSync(CUSTOM_DIR, { recursive: true });
            const { builtin: _b, ...clean } = spec;
            writeFileSync(join(CUSTOM_DIR, `${spec.id}.json`), JSON.stringify(clean, null, 2) + '\n', 'utf8');
            return send(res, 200, { saved: spec.id, warnings: check.warnings });
          }
          const pm = url.pathname.match(/^\/pipelines\/([^/]+)$/);
          if (req.method === 'DELETE' && pm) {
            const id = decodeURIComponent(pm[1]);
            if (!ID_RE.test(id)) return send(res, 400, { error: 'bad id' });
            if (isBuiltinId(id)) return send(res, 409, { error: 'built-in presets can not be deleted' });
            const p = join(CUSTOM_DIR, `${id}.json`);
            if (!existsSync(p)) return send(res, 404, { error: 'no such pipeline' });
            unlinkSync(p);
            return send(res, 200, { deleted: id });
          }
          if (req.method === 'POST' && url.pathname === '/run') {
            if (req.headers['content-type']?.split(';')[0] !== 'application/json')
              return send(res, 415, { error: 'send JSON' });
            if (active || activeBatch) return send(res, 409, { error: 'a run or batch is already in progress' });
            const b = JSON.parse(await readBody(req));
            // either a saved pipeline id, or an inline spec (an unsaved pipeline from the editor)
            let topology = b.topology;
            let specText: string | null = null;
            if (b.spec) {
              if (typeof b.spec.id !== 'string' || isBuiltinId(b.spec.id))
                return send(res, 400, { error: 'give an unsaved pipeline its own id (not a built-in one)' });
              specText = JSON.stringify(b.spec);
              const check = await validateSpec(specText);
              if (!check.ok) return send(res, 400, { error: `invalid pipeline: ${check.errors.join('; ')}` });
              topology = b.spec.id;
            } else if (typeof topology !== 'string' || !pipelineExists(topology)) {
              return send(res, 400, { error: `unknown pipeline ${JSON.stringify(topology)}` });
            }
            const backend = b.backend;
            const seed = Number(b.seed);
            const docText = String(b.docText ?? '');
            const docId = String(b.docId ?? '');
            const templateId = b.templateId ? String(b.templateId) : null;
            const position = b.position ? String(b.position) : null;
            if (!CONFIG_FOR[backend]) return send(res, 400, { error: 'bad backend' });
            if (!Number.isInteger(seed) || seed < 0 || seed > 1e9) return send(res, 400, { error: 'seed must be a whole number' });
            if (!ID_RE.test(docId)) return send(res, 400, { error: 'doc id: letters, digits, _ . - only (max 64)' });
            if (templateId && !ID_RE.test(templateId)) return send(res, 400, { error: 'template id: letters, digits, _ . - only' });
            if (position && !['start', 'middle', 'end'].includes(position)) return send(res, 400, { error: 'bad position' });
            const inject = b.inject === true; // insert the template's payload into the document (else templateId is just a label)
            if (inject && (!templateId || !position)) return send(res, 400, { error: 'pick a template and a position to inject at' });
            if (!docText.trim()) return send(res, 400, { error: 'the document is empty' });
            if (docText.length > MAX_DOC_CHARS) return send(res, 400, { error: 'document too long' });
            if (backend === 'anthropic' && !hasKey())
              return send(res, 400, { error: 'No ANTHROPIC_API_KEY found in .env or the environment.' });
            if (backend === 'ollama') {
              const host = readYamlField(CONFIG_FOR.ollama, 'ollama_host') || 'http://localhost:11434';
              if (!(await ollamaReachable(host)))
                return send(res, 400, { error: `Could not reach Ollama at ${host}. Install it and run ` +
                  `\`ollama serve\` (see docs/OLLAMA.md), and pull a model with ` +
                  `\`ollama pull ${readYamlField(CONFIG_FOR.ollama, 'model') ?? '<model>'}\`.` });
            }

            if (active || activeBatch) return send(res, 409, { error: 'a run or batch is already in progress' }); // re-check after the awaits
            let specFile: string | null = null;
            if (specText) {
              specFile = join(tmpdir(), `m117-pipeline-${process.pid}-${nextId}.json`);
              writeFileSync(specFile, specText, 'utf8');
            }
            const args = [join('scripts', 'run_one.py'), '--json', '--config', CONFIG_FOR[backend], '--backend', backend,
              ...(specFile ? ['--pipeline-file', specFile] : ['--topology', topology]),
              '--doc', '-', '--doc-id', docId, '--seed', String(seed)];
            if (templateId) args.push(inject ? '--inject-template' : '--template-id', templateId);
            if (position) args.push('--position', position);

            const job: Job = { id: String(nextId++), state: 'running', logPath: null, error: null,
              spentUsd: 0, stderr: '', startedAt: Date.now() };
            jobs.set(job.id, job);
            active = job;

            const child = spawn(pythonPath(), args, {
              cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
              windowsHide: true,
            });
            let buf = '';
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
              buf += chunk;
              let nl;
              while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line.startsWith('{')) continue;
                try {
                  const m = JSON.parse(line);
                  if (m.log) job.logPath = resolve(ROOT, m.log);
                  if (typeof m.spent_usd === 'number') job.spentUsd = m.spent_usd;
                  if (m.event === 'failed') job.error = m.error;
                } catch { /* not ours */ }
              }
            });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (c: string) => { job.stderr = (job.stderr + c).slice(-4000); });
            child.on('error', e => { job.state = 'failed'; job.error = `could not start Python: ${e.message}`; active = null; });
            child.on('close', code => {
              if (job.state === 'running') {
                job.state = code === 0 ? 'done' : 'failed';
                if (code !== 0 && !job.error) job.error = job.stderr.trim().split('\n').slice(-3).join('\n') || `exit code ${code}`;
              }
              sessionSpent += job.spentUsd;
              if (active === job) active = null;
              if (specFile) { try { unlinkSync(specFile); } catch { /* already gone */ } }
            });
            child.stdin.end(docText, 'utf8');
            return send(res, 202, { job: job.id });
          }
          if (req.method === 'POST' && url.pathname === '/batch') {
            if (req.headers['content-type']?.split(';')[0] !== 'application/json')
              return send(res, 415, { error: 'send JSON' });
            if (active || activeBatch) return send(res, 409, { error: 'a run or batch is already in progress' });
            const b = JSON.parse(await readBody(req));
            const strs = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : []);
            const pipelinesSel = strs(b.pipelines), docsSel = strs(b.docs), tplSel = strs(b.templateIds);
            const positions = strs(b.positions), seeds = Array.isArray(b.seeds) ? b.seeds.map(Number) : [];
            const backend = String(b.backend ?? '');
            const maxRuns = Number(b.maxRuns);
            const withClean = b.withClean === true;
            const assigned = b.assigned === true; // each document with its own assigned poison, not every template x position
            const docNames = new Set(listTxt(DATA_DIR).map(d => d.name));
            if (!pipelinesSel.length || !pipelinesSel.every(pipelineExists)) return send(res, 400, { error: 'pick existing pipelines' });
            if (!docsSel.length || !docsSel.every(d => docNames.has(d))) return send(res, 400, { error: 'pick documents from data/' });
            if (!tplSel.every(t => ID_RE.test(t))) return send(res, 400, { error: 'bad template id' });
            if (!assigned && !tplSel.length && !withClean) return send(res, 400, { error: 'pick at least one attack template, or include clean runs' });
            if (!assigned && tplSel.length && (!positions.length || !positions.every(p => ['start', 'middle', 'end'].includes(p))))
              return send(res, 400, { error: 'pick at least one position' });
            if (!seeds.length || seeds.length > 20 || !seeds.every(s => Number.isInteger(s) && s >= 0 && s <= 1e9))
              return send(res, 400, { error: 'seeds: up to 20 whole numbers' });
            if (!CONFIG_FOR[backend]) return send(res, 400, { error: 'bad backend' });
            if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 1000) return send(res, 400, { error: 'maxRuns: 1 to 1000' });
            if (backend === 'anthropic' && !hasKey())
              return send(res, 400, { error: 'No ANTHROPIC_API_KEY found in .env or the environment.' });
            if (backend === 'ollama') {
              const host = readYamlField(CONFIG_FOR.ollama, 'ollama_host') || 'http://localhost:11434';
              if (!(await ollamaReachable(host))) return send(res, 400, { error: `Could not reach Ollama at ${host}.` });
            }
            if (active || activeBatch) return send(res, 409, { error: 'a run or batch is already in progress' });

            const args = [join('scripts', 'run_batch.py'), '--json', '--config', CONFIG_FOR[backend], '--backend', backend,
              '--docs', ...docsSel.map(d => join('data', d)), '--pipelines', ...pipelinesSel,
              '--seeds', ...seeds.map(String), '--max-runs', String(maxRuns)];
            if (assigned) args.push('--assigned');
            else if (tplSel.length) args.push('--template-ids', ...tplSel, '--positions', ...positions);
            else args.push('--no-attacks');
            if (withClean) args.push('--with-clean');

            const job: BatchJob = { id: String(nextId++), state: 'running', total: 0, rows: [], current: null, overwrites: [], error: null,
              spentUsd: 0, summary: null, model: null, stderr: '', startedAt: Date.now(), child: null };
            batches.set(job.id, job);
            activeBatch = job;
            const child = spawn(pythonPath(), args, {
              cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }, windowsHide: true,
            });
            job.child = child;
            let buf = '';
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
              buf += chunk;
              let nl;
              while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line.startsWith('{')) continue;
                try {
                  const m = JSON.parse(line);
                  if (m.event === 'plan') { job.total = m.total; job.overwrites = m.overwrites ?? []; job.model = m.model ?? null; }
                  else if (m.event === 'start') job.current = m.run_id;
                  else if (m.event === 'run') job.rows.push(m);
                  else if (m.event === 'summary') { job.summary = m; job.spentUsd = m.spent_usd ?? 0; }
                  else if (m.event === 'error') job.error = m.error;
                  else if (m.event === 'stopped') job.error = m.reason;
                } catch { /* not ours */ }
              }
            });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (c: string) => { job.stderr = (job.stderr + c).slice(-4000); });
            child.on('error', e => { job.state = 'failed'; job.error = `could not start Python: ${e.message}`; activeBatch = null; });
            child.on('close', code => {
              if (job.state === 'running') {
                job.state = code === 0 ? 'done' : 'failed';
                if (code !== 0 && !job.error) job.error = job.stderr.trim().split('\n').slice(-3).join('\n') || `exit code ${code}`;
              }
              sessionSpent += job.spentUsd;
              if (activeBatch === job) activeBatch = null;
            });
            return send(res, 202, { job: job.id });
          }
          const bm = url.pathname.match(/^\/batch\/(\d+)(\/stop)?$/);
          if (bm && (req.method === 'GET' || (req.method === 'POST' && bm[2]))) {
            const job = batches.get(bm[1]);
            if (!job) return send(res, 404, { error: 'no such batch' });
            if (bm[2]) {
              if (job.state === 'running') { job.state = 'stopped'; job.child?.kill(); }
              return send(res, 200, { state: job.state });
            }
            return send(res, 200, {
              state: job.state, total: job.total, rows: job.rows, current: job.current, overwrites: job.overwrites, error: job.error,
              spentUsd: job.spentUsd, summary: job.summary, model: job.model, elapsedMs: Date.now() - job.startedAt,
            });
          }
          const m = url.pathname.match(/^\/run\/(\d+)$/);
          if (req.method === 'GET' && m) {
            const job = jobs.get(m[1]);
            if (!job) return send(res, 404, { error: 'no such job' });
            const log = job.logPath && existsSync(job.logPath) ? readFileSync(job.logPath, 'utf8') : '';
            return send(res, 200, {
              state: job.state, error: job.error, spentUsd: job.spentUsd, sessionSpentUsd: sessionSpent,
              elapsedMs: Date.now() - job.startedAt,
              log: log.slice(0, log.lastIndexOf('\n') + 1), // only complete lines
              logName: job.logPath ? job.logPath.split(/[\\/]/).pop() : null,
            });
          }
          return send(res, 404, { error: 'unknown endpoint' });
        } catch (e) {
          return send(res, 500, { error: (e as Error).message });
        }
      });
    },
  };
}
