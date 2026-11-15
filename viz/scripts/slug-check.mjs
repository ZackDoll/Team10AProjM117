// The run-id model slug must be the same in the viewer (src/api.ts) and in Python (model_slug in
// src/m117/pipeline.py), or the batch tab would predict the wrong ids. Run with `npm run test:slug`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { modelSlug } = await import(new URL('../src/api.ts', import.meta.url));
const models = ['claude-haiku-5-5', 'qwen2.5:3b-instruct', 'stub', 'org/Model_v2 (beta)', 'a__b', '::', '', '  x  ', 'llama3.2:3b-instruct', '-lead-and-trail-'];
const root = fileURLToPath(new URL('../../', import.meta.url));
const py = ['.venv/Scripts/python.exe', '.venv/bin/python'].map(p => root + p).find(p => existsSync(p));
const script = "import json,sys; sys.path.insert(0,'src'); from m117.pipeline import model_slug; print(json.dumps([model_slug(m) for m in json.load(sys.stdin)]))";
const fromPython = JSON.parse(execFileSync(py ?? 'python', ['-c', script], { cwd: root, input: JSON.stringify(models), encoding: 'utf8' }));
models.forEach((m, i) => assert.equal(modelSlug(m), fromPython[i], `slug of ${JSON.stringify(m)}`));
console.log(`ok   model slug matches Python for ${models.length} model names`);
