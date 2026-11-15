// Word-level diff (longest common subsequence). Self-contained so `npm run test:diff` can run it in Node.

export type DiffOp = { op: 'same' | 'add' | 'del'; text: string };

/** Words and line breaks; other whitespace is dropped and re-added as single spaces. */
const tokenize = (s: string) => s.match(/\n|[^\s]+/g) ?? [];

function join(tokens: string[]): string {
  let out = '';
  tokens.forEach((t, i) => {
    out += (i > 0 && t !== '\n' && tokens[i - 1] !== '\n' ? ' ' : '') + t;
  });
  return out;
}

/** What changed going from `before` to `after`. Adjacent tokens with the same fate are merged. Inputs
 *  too large for the table (over ~4M cells) come back as one deletion and one addition. */
export function diffWords(before: string, after: string): DiffOp[] {
  const a = tokenize(before), b = tokenize(after);
  const n = a.length, m = b.length;
  if (n === 0 && m === 0) return [];
  if (n * m > 4_000_000) {
    return [...(n ? [{ op: 'del' as const, text: join(a) }] : []), ...(m ? [{ op: 'add' as const, text: join(b) }] : [])];
  }
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const steps: { op: DiffOp['op']; t: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { steps.push({ op: 'same', t: a[i] }); i++; j++; }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) steps.push({ op: 'del', t: a[i++] });
    else steps.push({ op: 'add', t: b[j++] });
  }
  while (i < n) steps.push({ op: 'del', t: a[i++] });
  while (j < m) steps.push({ op: 'add', t: b[j++] });

  const out: DiffOp[] = [];
  let run: string[] = [];
  let cur: DiffOp['op'] | null = null;
  const flush = () => { if (cur && run.length) out.push({ op: cur, text: join(run) }); run = []; };
  for (const s of steps) {
    if (s.op !== cur) { flush(); cur = s.op; }
    run.push(s.t);
  }
  flush();
  return out;
}

/** True when the two texts have the same words in the same order (spacing differences don't count). */
export const sameWords = (a: string, b: string) => join(tokenize(a)) === join(tokenize(b));
