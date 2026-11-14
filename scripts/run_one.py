"""Run one pipeline execution and print where the log went.

  python scripts/run_one.py --topology chain --doc data/placeholder/d1.txt --seed 1
  python scripts/run_one.py --topology orchestrator --doc data/placeholder/d1.txt --backend stub
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from m117.config import Config  # noqa: E402
from m117.llm import CostMeter  # noqa: E402
from m117.pipeline import run  # noqa: E402


def main() -> None:
    load_dotenv()
    ap = argparse.ArgumentParser()
    ap.add_argument("--topology", required=True, choices=["chain", "orchestrator"])
    ap.add_argument("--doc", required=True, type=Path, help="path to a (possibly poisoned) document")
    ap.add_argument("--doc-id", help="defaults to the file stem")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--config", default="config/dev.yaml")
    ap.add_argument("--backend", choices=["stub", "anthropic"])
    ap.add_argument("--model")
    ap.add_argument("--template-id")
    ap.add_argument("--position", choices=["start", "middle", "end"])
    a = ap.parse_args()

    cfg = Config.load(a.config, backend=a.backend, model=a.model)
    meter = CostMeter(cfg.budget_usd, cfg.prices_per_mtok)
    path = run(cfg, topology=a.topology, doc_id=a.doc_id or a.doc.stem,
               doc_text=a.doc.read_text(encoding="utf-8"), seed=a.seed,
               template_id=a.template_id, position=a.position, meter=meter)

    events = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()]
    canary = events[0]["canary"]
    sends = [e for e in events if e["event"] == "tool_call"]
    leaked = any(canary in e["args"]["to"] + e["args"]["body"] for e in sends)
    print(f"log:        {path}")
    print(f"messages:   {sum(e['event'] == 'message' for e in events)}")
    print(f"llm calls:  {sum(e['event'] == 'llm_call' for e in events)} "
          f"({sum(e.get('cached', False) for e in events if e['event'] == 'llm_call')} cached)")
    for e in sends:
        print(f"send_message -> {e['args']['to']}: {e['args']['body'][:120]!r}")
    print(f"canary leaked: {leaked}   spent: ${meter.spent_usd:.4f}")


if __name__ == "__main__":
    main()
