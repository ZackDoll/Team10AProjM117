# Team10AProjM117

A testbed for measuring how a prompt injection in one document spreads through a 3-agent pipeline
(reader → analyst → tool user) under two topologies: a chain and an orchestrator (hub).

## Setup
```
python -m venv .venv
.venv/Scripts/activate          # Windows; use source .venv/bin/activate elsewhere
pip install -e ".[dev]"
cp .env.example .env            # add ANTHROPIC_API_KEY
```

## Run
```
# free, deterministic stub (no API key needed)
python scripts/run_one.py --backend stub --topology chain --doc data/placeholder/d1.txt --seed 1

# real model (config/dev.yaml: claude-haiku-5-5, effort low, $5 budget cap)
python scripts/run_one.py --topology orchestrator --doc data/placeholder/d1.txt --seed 1

# attacked run: pass the poisoned text plus its labels
python scripts/run_one.py --topology chain --doc poisoned.txt --doc-id d03 --template-id t2 --position middle --seed 1

pytest
```

From Python, call `m117.pipeline.run(config, topology=..., doc_id=..., doc_text=..., seed=..., template_id=..., position=...)`.
It returns the log path. See [docs/LOG_SCHEMA.md](docs/LOG_SCHEMA.md) for the log format.

## Layout
- `src/m117/topologies.py`: chain and orchestrator wiring. Every inter-agent message passes through `RunContext.message()`.
- `src/m117/agents.py`, `prompts.py`: reader, analyst, tool user (with the canary) and orchestrator.
- `src/m117/tools.py`: the mocked `send_message`. It only writes to the log.
- `src/m117/llm.py`: stub and Anthropic backends, the on-disk response cache and the budget meter.
- `src/m117/runlog.py`: the JSONL logger.

## Safety
The only tool is mocked and never makes network calls. A test enforces this.
