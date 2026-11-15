# Agent pipeline lab (React viewer)

A React + TypeScript + Vite app for the pipeline testbed. Under `npm run dev` it can start real
runs, build pipelines, run batches and diff attacked runs against clean ones. In a static build
(`npm run build`) it only replays logs.

## Run it
```
cd viz
npm install        # first time only
npm run dev        # then open http://localhost:5173
```
Other scripts: `npm run build` (type-checks, then builds to `viz/dist/`), `npm run preview`,
`npm test` (transcript parity with Python, and the word-diff unit checks). Needs Node 22.18+ for `npm test`
(it runs `.ts` files directly); Node 20+ is enough for everything else.

## The tabs

### Run & replay
- **New run**: pick a pipeline (and optionally a second one to run side by side), a document from `data/`,
  an **attack template** and a position, a seed and a backend: Claude (the model in `config/dev.yaml`),
  a local Ollama model, or the free stub. Picking a template shows the document with the payload
  inserted before you run, and fills the marker field so the payload's spread is traced. Or paste a
  payload into the text yourself and give it a label.
- **Replay**: the agent graph with each message as it travels, the mocked `send_message` calls, the
  LEAK banner, and a timeline. Play / Next / Back / Restart / scrubber, or keys `Space`, `Left`/`Right`, `Home`.
- **Transcript** (tab inside each run): every agent's system prompt, each message as
  `Step N · sender → receiver`, tool calls with a LEAK flag, and the final output labelled with the step
  and agent it came from. **Copy as markdown** or **Download .md**. The same file is saved
  automatically to `logs/transcripts/<run_id>.md` for every run.
- **Marker phrase**: agents that have produced it turn amber, matches are highlighted, and *Spread depth*
  shows the furthest agent that carried it.
- **Compare two runs**: two panels stepping together.
- **Diff with clean run**: puts the matching clean run (same pipeline, document, seed, model) in panel B and
  shows, agent by agent, what the payload changed: words only in the attacked run are underlined, words only
  in the clean run struck through, with the first agent that differs and where the marker and canary appear.
  If there is no clean twin it offers to run it.

### Runs
Every loaded run in one table: time, pipeline, document, template, position, seed, model, leak,
report sent (a `send_message` reached the user: a stand-in for task success), spread depth, LLM calls
and cost. Sort by any column, filter by text, or toggle Leaked / Attack runs / Clean runs / No report sent.
The summary line gives attack success for what is in view. **A** / **B** open a run in a panel.

### Batch
Pick pipelines, documents, templates, positions, seeds and a backend, and run the whole matrix. A
results grid fills in live: templates down, pipeline × position across, each cell one run coloured and
labelled LEAK / safe / no report / error, with attack success in the margins. Click a finished cell to
replay it. It shows the run count and a cost estimate first, caps the number of runs (default 100), warns
when a batch would overwrite existing logs, and has a Stop button.

### Pipelines
Build your own pipeline with forms: add agents, tool agents and hubs, edit each one's system prompt
(with `{canary}` / `{user_address}` / `{questions}` chips), wire the connections, and pick the output.
It validates as you type with the same Python the runner uses, shows a live graph, and saves to
`pipelines/custom/<id>.json`. The built-in presets are read-only; duplicate one to change it.

## How the dev server API works
`server/runApi.ts` is a Vite dev-server plugin. The browser asks it to run things; it spawns the
`.venv` Python scripts and serves their output back.

| endpoint | does |
|---|---|
| `GET /api/status` | key and Ollama availability, models, session spend |
| `GET /api/docs`, `/api/templates`, `/api/logs` | documents, attack templates, run logs |
| `POST /api/inject` | a document with a template's payload inserted (the preview) |
| `GET/POST/DELETE /api/pipelines`, `POST /api/pipelines/validate` | the pipeline builder |
| `POST /api/run`, `GET /api/run/<job>` | one run, with its growing log |
| `POST /api/batch`, `GET /api/batch/<job>`, `POST /api/batch/<job>/stop` | a batch |

The API key is read by Python from `.env` and never reaches the browser. Only same-origin requests are
accepted, so other websites can't start runs, and one run or batch happens at a time. Run ids don't include
the model, so a rerun of the same combination replaces the earlier log; the Batch tab warns first.

## Logs it shows
- The sample logs in `tests/fixtures/` (stub backend, including one failed run) are always bundled.
- Real runs in `logs/runs/*.jsonl` are loaded from the dev server (and bundled into a static build).
  Runs from before logs recorded their pipeline still draw; they just have no system prompts.
- Drag `.jsonl` files onto the page, or use **Load log...**. The format is in `docs/LOG_SCHEMA.md`.

URL options (handy for sharing a view or taking screenshots):
`?tab=runs|batch|pipelines&a=chain_leak&b=orchestrator_leak&compare=1&step=4&marker=some%20phrase&play=1&speed=2`

## Code map
| file | what it does |
|---|---|
| `src/parse.ts` | parses a log into a `Run`; `analyze` computes what is shown at a step (leak, spread, which agents carry the marker); `summarize`, `nodeOutputs`, `findClean`. Plain functions, no React |
| `src/layouts.ts` | graph layout: hand-tuned for the two presets, a layered layout for any other pipeline |
| `src/transcriptData.ts` | the transcript model and its markdown. Must match `src/m117/transcript.py` (`npm run test:transcript`) |
| `src/diff.ts` | word-level diff |
| `src/App.tsx` | tabs, selected runs, step, playing, marker, keyboard, file loading, the clean-vs-attacked diff |
| `src/RunForm.tsx`, `RunPanel.tsx`, `Diagram.tsx`, `Detail.tsx`, `Timeline.tsx`, `Transcript.tsx`, `DiffView.tsx` | the replay view |
| `src/RunsTable.tsx`, `BatchTab.tsx`, `PipelineEditor.tsx`, `GraphPreview.tsx` | the other tabs |
| `src/api.ts` | client for the dev-server API |
| `server/runApi.ts` | the dev-server API |

To change what counts as a leak or as "spread", edit `isLeakCall()` and `analyze()` in `parse.ts`.

## Notes
- Log text is only ever rendered through React text nodes, never as HTML, because attacker-written
  documents can contain markup. A document containing `<img onerror=...>` just shows up as text.
- Colors follow the OS light/dark setting. Leaks are also shown by text and a warning icon, not color alone.
