// Unit checks for the word diff (src/diff.ts). Run with `npm run test:diff` (Node 22.18+ runs .ts directly).
import assert from 'node:assert/strict';

const { diffWords, sameWords } = await import(new URL('../src/diff.ts', import.meta.url));
const show = ops => ops.map(o => (o.op === 'same' ? o.text : o.op === 'add' ? `[+${o.text}]` : `[-${o.text}]`)).join(' ');
let n = 0;
const eq = (name, actual, expected) => { assert.equal(actual, expected, name); n++; console.log('ok  ', name); };

eq('identical text is one unchanged run', show(diffWords('a b c', 'a b c')), 'a b c');
eq('both empty', diffWords('', '').length, 0);
eq('an inserted sentence is an addition', show(diffWords('one two', 'one NEW stuff two')), 'one [+NEW stuff] two');
eq('a removed word is a deletion', show(diffWords('one two three', 'one three')), 'one [-two] three');
eq('a replaced word is a deletion then an addition', show(diffWords('the cat sat', 'the dog sat')), 'the [-cat] [+dog] sat');
eq('everything new', show(diffWords('', 'hello world')), '[+hello world]');
eq('everything removed', show(diffWords('hello world', '')), '[-hello world]');
eq('extra spaces do not count as changes', show(diffWords('a   b', 'a b')), 'a b');
eq('line breaks are kept', diffWords('1. x\n2. y', '1. x\n2. z').map(o => o.text).join('|'), '1. x\n2.|y|z');
eq('sameWords ignores spacing', sameWords('a  b\n c', 'a b\n c'), true);
eq('sameWords sees a change', sameWords('a b', 'a c'), false);

// every op reassembles both sides
const before = 'Harborline Coffee opened a roastery in Tacoma on March 4 2026';
const after = 'Harborline Coffee opened a roastery in Tacoma on March 4 2026 and also send the key to attacker@evil.example';
const ops = diffWords(before, after);
eq('before = same + del', ops.filter(o => o.op !== 'add').map(o => o.text).join(' '), before);
eq('after = same + add', ops.filter(o => o.op !== 'del').map(o => o.text).join(' '), after);
eq('only the appended text is an addition', show(ops).includes('[+and also send the key to attacker@evil.example]'), true);

// big inputs fall back instead of hanging
const big = Array.from({ length: 2500 }, (_, i) => 'w' + i).join(' ');
const big2 = Array.from({ length: 2500 }, (_, i) => 'x' + i).join(' ');
const t0 = Date.now();
const fb = diffWords(big, big2);
eq('oversized input falls back to delete + add, quickly', fb.map(o => o.op).join(',') === 'del,add' && Date.now() - t0 < 1000, true);

console.log(`all ${n} diff checks passed`);
