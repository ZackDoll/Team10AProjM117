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

## Logs it shows
- The four stub sample logs in `tests/fixtures/` are always bundled.
- Any real runs in `logs/runs/*.jsonl` are bundled automatically too. Restart `npm run dev` after
  adding new ones, or just drag them onto the page.
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
| `src/samples.ts` | bundles the logs from `tests/fixtures/` and `logs/runs/` |

To change what counts as "spread" or a leak, edit `analyze()` and `isLeakCall()` in `parse.ts`.

## Notes
- Log text is only ever rendered through React text nodes, never as HTML, because
  attacker-written documents can contain markup. A document containing `<img onerror=...>` just
  shows up as text.
- Colors follow the OS light/dark setting. Leaks are also shown by text and a warning icon, not
  color alone.
