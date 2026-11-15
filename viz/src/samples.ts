// Bundled logs. Vite inlines them at build time, so the static build needs no server.
// The stub sample logs ship with the repo. Real runs in logs/runs/ are bundled into a static
// build too; under `npm run dev` they are fetched live from /api/logs instead (see api.ts), so
// new runs appear without a restart.
const samples = import.meta.glob('../../tests/fixtures/sample_*.jsonl', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;
const real = import.meta.env.DEV ? {} : import.meta.glob('../../logs/runs/*.jsonl', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const nameOf = (path: string) => path.split('/').pop()!;

export const SAMPLES: { name: string; text: string }[] = [
  ...Object.entries(samples).map(([p, text]) => ({ name: nameOf(p), text })),
  ...Object.entries(real).map(([p, text]) => ({ name: nameOf(p), text })),
];
