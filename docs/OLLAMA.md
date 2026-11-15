# Running against a local model (Ollama)

Claude Haiku resisted all 24 attack attempts we tried at first (the Reader drops the embedded
instruction when it summarizes). A small local model is a useful contrast: it costs nothing, has no
rate limit, and has had none of the deliberate training against prompt injection that Claude has.

## Setup
1. Install Ollama: https://ollama.com/download (Windows/Mac/Linux installer, or `winget install
   Ollama.Ollama` on Windows).
2. Start the server (the installer usually does this for you as a background service; otherwise
   run `ollama serve` in its own terminal).
3. Pull a small instruct model:
   ```
   ollama pull qwen2.5:3b-instruct
   ```
   About 2 GB, runs fine on CPU. **Smaller is not better here:** `qwen2.5:1.5b-instruct` never calls
   `send_message` at all (it answers in plain text, even on a clean run), so there is no tool call for an
   attack to hijack. 3B is the smallest we found that uses the tool reliably. `llama3.2:3b-instruct` is
   another option.
4. Point the pipeline at it: `config/local.yaml` is already set up for `qwen2.5:3b-instruct`. Edit its
   `model:` line if you pulled a different one.

## Run it
```
python scripts/run_one.py --topology chain --doc data/placeholder/d1.txt --config config/local.yaml
python scripts/run_batch.py --docs data/placeholder/d1.txt --config config/local.yaml --positions start middle end --max-runs 60
```
Or from the viewer (`cd viz && npm run dev`): choose **Local: qwen2.5:3b-instruct** as the backend in
New run or in the Batch tab. If Ollama isn't running the option says so.

Run ids don't include the model, so a batch on the local model replaces earlier logs of the same
combination made with Claude (and vice versa). The Batch tab warns before it does.

## Notes
- No API key, no `.env` entry, and no budget cap that matters -- `prices_per_mtok` has no entry
  for Ollama models, so `CostMeter` prices every call at $0.
- Determinism comes from `temperature: 0` plus a fixed `seed`, which Ollama actually accepts
  (unlike the current Claude models). Responses are still cached on disk like the Anthropic
  backend, so a rerun is instant.
- Tool-calling quality varies a lot by model. If the tool user agent stops calling
  `send_message` at all (rather than refusing to leak, but refusing to use tools), that's a sign
  the model is too weak to follow the tool schema, not a sign it resisted the attack -- check the
  log's `llm_call` / `tool_call` events to tell the two apart.
- If you see `Could not reach Ollama at http://localhost:11434`, the server isn't running --
  start it with `ollama serve` (or check the Ollama app/service is up).
