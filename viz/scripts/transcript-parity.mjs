// Checks that the viewer's markdown transcript (src/transcriptData.ts) is byte-identical to the one
// Python wrote (src/m117/transcript.py) for every sample log in tests/fixtures/.
//   npm run test:transcript        (needs Node 22.18+, which runs .ts files directly)
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../../tests/fixtures/', import.meta.url);
const { buildTranscript, renderMarkdown } = await import(new URL('../src/transcriptData.ts', import.meta.url));

let bad = 0, n = 0;
for (const f of readdirSync(dir).filter(f => /^sample_.*\.jsonl$/.test(f)).sort()) {
  const events = readFileSync(new URL(f, dir), 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
  const got = renderMarkdown(buildTranscript(events));
  const want = readFileSync(new URL(f.replace(/\.jsonl$/, '.md'), dir), 'utf8').replace(/\r\n/g, '\n');
  n++;
  if (got === want) { console.log('ok      ', f); continue; }
  bad++;
  const g = got.split('\n'), w = want.split('\n');
  const i = g.findIndex((l, k) => l !== w[k]);
  console.log('MISMATCH', f, `at line ${i + 1}\n   ts : ${JSON.stringify(g[i])}\n   py : ${JSON.stringify(w[i])}`);
}
console.log(bad ? `${bad} of ${n} differ` : `all ${n} transcripts match the Python output`);
process.exit(bad ? 1 : 0);
