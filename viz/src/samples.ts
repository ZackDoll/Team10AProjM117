// Bundled logs. Vite inlines them at build time, so there is no fetch and no server config.
// Sample logs (stub backend) ship with the repo. Real runs in logs/runs/ show up automatically
// when they exist (restart `npm run dev` if you add some while it is running).
const samples = import.meta.glob('../../tests/fixtures/sample_*.jsonl', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;
const real = import.meta.glob('../../logs/runs/*.jsonl', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const nameOf = (path: string) => path.split('/').pop()!;

export const SAMPLES: { name: string; text: string }[] = [
  ...Object.entries(samples).map(([p, text]) => ({ name: nameOf(p), text })),
  ...Object.entries(real).map(([p, text]) => ({ name: nameOf(p), text })),
];
