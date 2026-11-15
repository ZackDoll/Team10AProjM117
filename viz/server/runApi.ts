// Dev-server API that lets the viewer start real pipeline runs.
//
// The browser never sees the API key: it asks this local server to run
// `python scripts/run_one.py --json ...`, the Python side reads ANTHROPIC_API_KEY from .env, and
// this server streams the growing JSONL log back as the run progresses. backend: "ollama" runs
// against a local model through Ollama instead (config/local.yaml, no key needed).
//
//   GET  /api/status        python path, key/Ollama availability, models, session spend
//   GET  /api/docs          .txt documents under data/ (name + text), for the document picker
//   GET  /api/logs          every log in logs/runs/ (so new runs show up without a restart)
//   POST /api/run           start a run; body {topology, docText, docId, seed, backend, templateId?, position?}
//   GET  /api/run/<job>     {state, log, error, spentUsd}; poll this while the run is going
//
// Only exists under `npm run dev`. A static build (`npm run build`) has no API and just replays logs.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

const ROOT = resolve(import.meta.dirname, '..', '..');
const RUNS_DIR = join(ROOT, 'logs', 'runs');
const DATA_DIR = join(ROOT, 'data');
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
              config: CONFIG_FOR.anthropic, sessionSpentUsd: sessionSpent, running: active?.id ?? null,
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
          if (req.method === 'POST' && url.pathname === '/run') {
            if (req.headers['content-type']?.split(';')[0] !== 'application/json')
              return send(res, 415, { error: 'send JSON' });
            if (active) return send(res, 409, { error: 'a run is already in progress' });
            const b = JSON.parse(await readBody(req));
            const topology = b.topology;
            const backend = b.backend;
            const seed = Number(b.seed);
            const docText = String(b.docText ?? '');
            const docId = String(b.docId ?? '');
            const templateId = b.templateId ? String(b.templateId) : null;
            const position = b.position ? String(b.position) : null;
            if (topology !== 'chain' && topology !== 'orchestrator') return send(res, 400, { error: 'bad topology' });
            if (!CONFIG_FOR[backend]) return send(res, 400, { error: 'bad backend' });
            if (!Number.isInteger(seed) || seed < 0 || seed > 1e9) return send(res, 400, { error: 'seed must be a whole number' });
            if (!ID_RE.test(docId)) return send(res, 400, { error: 'doc id: letters, digits, _ . - only (max 64)' });
            if (templateId && !ID_RE.test(templateId)) return send(res, 400, { error: 'template id: letters, digits, _ . - only' });
            if (position && !['start', 'middle', 'end'].includes(position)) return send(res, 400, { error: 'bad position' });
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

            const args = [join('scripts', 'run_one.py'), '--json', '--config', CONFIG_FOR[backend], '--backend', backend,
              '--topology', topology, '--doc', '-', '--doc-id', docId, '--seed', String(seed)];
            if (templateId) args.push('--template-id', templateId);
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
            });
            child.stdin.end(docText, 'utf8');
            return send(res, 202, { job: job.id });
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
