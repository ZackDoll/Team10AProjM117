# Run replay viewer (React)

A small React + TypeScript + Vite app that replays logged pipeline runs: the agent graph, each
message as it travels, the mocked `send_message` calls, whether the canary leaked, and how far a
payload's marker phrase spread. Everything runs in the browser. Nothing is sent anywhere.

## Run it
```
cd viz
npm install        # first time only
npm run dev        # then open http://localhost:5173
```
Other scripts: `npm run build` (type-checks, then builds to `viz/dist/`), `npm run preview`.
Needs Node 20+.

## Starting real runs from the page
Under `npm run dev`, the **New run** box at the top runs the actual pipeline:
1. Pick a document from `data/` (any `.txt` under it is listed), or edit the text. Paste a
   payload into it to test an attack. Give it a template id and position if you want it labelled
   as an attack run.
2. Pick chain, orchestrator, or **both** (fills panels A and B side by side), a seed, and the
   backend: Claude (the model in `config/dev.yaml`, Haiku by default) or the free stub.
3. Press **Run**. The panel follows the run live as each message hop is logged. A Haiku run takes
   about 15-40 s and costs well under a cent. Rerunning the same text + seed is answered from the
   cache for $0. The header shows what this dev-server session has spent.

How it works: `server/runApi.ts` is a Vite dev-server plugin. The browser asks it to start a run,
it spawns `.venv` Python running `scripts/run_one.py --json --doc -`, and it serves the growing
`logs/runs/<run_id>.jsonl` back to the page. The API key is read by Python from `.env` and never
reaches the browser. The API only accepts same-origin requests, so other sites can't trigger runs,
and only one run happens at a time. The static build (`npm run build`) has no API and only replays.

## Logs it shows
- The four stub sample logs in `tests/fixtures/` are always bundled.
- Real runs in `logs/runs/*.jsonl` are loaded from the dev server when the page opens (and are
  bundled into a static build).
- Drag `.jsonl` files onto the page, or use **Load log...**. In compare mode, two dropped files
  fill panels A and B. The format is in `docs/LOG_SCHEMA.md`.

## Using it
- **Play / Next / Back / Restart / scrubber**, or keys: `Space` play/pause, `Left`/`Right` step,
  `Home` restart. One step is one message hop, plus everything the receiving agent does before
  the next message.
- **Chain / Orchestrator** buttons in a panel switch to a loaded run with that topology.
- **Marker phrase**: paste a payload's marker. Agents that have produced it turn amber and say
  "marker present", matches are highlighted, and *Spread depth* shows the furthest of
  reader / analyst / tool user. The "marker is in the document" hint helps catch typos.
- **LEAK banner**: shown when the run's canary appears in any `send_message` call, with the
  destination and whether it is external.
- **Compare two runs**: two panels stepping together by hop number. A shorter run stays at its
  final state while the longer one finishes.
- **Timeline**: click any event to jump to it.

URL options (handy for sharing a view or taking screenshots):
`?a=chain_leak&b=orchestrator_leak&compare=1&step=4&marker=some%20phrase&play=1&speed=2`

## Code map
| file | what it does |
|---|---|
| `src/parse.ts` | parses a log into a `Run`; `analyze(run, step, marker)` computes everything shown at a step (leak, spread depth, which agents carry the marker). Plain functions, no React |
| `src/layouts.ts` | node positions and arrow geometry for each topology |
| `src/App.tsx` | state (selected runs, step, playing, marker), keyboard, file loading |
| `src/RunPanel.tsx` | one run: summary, banner, diagram, detail, timeline |
| `src/Diagram.tsx` | the SVG graph and the packet animation |
| `src/Detail.tsx`, `Timeline.tsx`, `Highlight.tsx` | message detail, event list, canary/marker highlighting |
| `src/samples.ts` | bundles the logs from `tests/fixtures/` (and `logs/runs/` in a static build) |
| `src/RunForm.tsx`, `src/api.ts` | the New run box and its client for the dev-server API |
| `server/runApi.ts` | dev-server plugin: `/api/status`, `/api/docs`, `/api/logs`, `/api/run` |

To change what counts as "spread" or a leak, edit `analyze()` and `isLeakCall()` in `parse.ts`.

## Notes
- Log text is only ever rendered through React text nodes, never as HTML, because
  attacker-written documents can contain markup. A document containing `<img onerror=...>` just
  shows up as text.
- Colors follow the OS light/dark setting. Leaks are also shown by text and a warning icon, not
  color alone.
