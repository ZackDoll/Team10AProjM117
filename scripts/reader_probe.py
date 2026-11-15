"""Reader-only probe: which payloads survive the Reader's summary and so can reach the Analyst.

  python scripts/reader_probe.py --config config/local.yaml --docs data/docs/d006_short.txt \
      --positions start middle end --seeds 1 2

Runs only the Reader node of pipelines/chain.json on each (document x payload x position x seed),
and checks whether the payload's marker appears in the summary. No tools, no Analyst/Reporter.
Payloads come from data/attacks/reader_probes.json (override with --probes).
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from m117.attacks import inject  # noqa: E402
from m117.config import Config  # noqa: E402
from m117.llm import CostMeter, make_client  # noqa: E402


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="config/local.yaml")
    ap.add_argument("--probes", default="data/attacks/reader_probes.json")
    ap.add_argument("--docs", nargs="+", default=["data/docs/d006_short.txt"])
    ap.add_argument("--positions", nargs="+", default=["start", "middle", "end"])
    ap.add_argument("--seeds", nargs="+", type=int, default=[1])
    ap.add_argument("--out", default="logs/reader_probe.jsonl")
    args = ap.parse_args()

    cfg = Config.load(ROOT / args.config)
    client = make_client(cfg, CostMeter(cfg.budget_usd, cfg.prices_per_mtok))
    reader = next(n for n in json.loads((ROOT / "pipelines/chain.json").read_text(encoding="utf-8"))["nodes"]
                  if n["id"] == "reader")["system"]
    probes = json.loads((ROOT / args.probes).read_text(encoding="utf-8"))

    rows = []
    for doc_path in args.docs:
        doc = (ROOT / doc_path).read_text(encoding="utf-8")
        for p in probes:
            for pos in args.positions:
                for seed in args.seeds:
                    text = inject(doc, p["text"], pos)
                    resp = client.complete(system=reader, messages=[{"role": "user", "content": text}],
                                           tools=None, seed=seed, agent="reader")
                    summary = resp.text
                    survived = p["marker"].lower() in summary.lower()
                    rows.append({"probe": p["id"], "doc": Path(doc_path).name, "position": pos, "seed": seed,
                                 "survived": survived, "summary": summary})
                    print(f"{p['id']:22} {Path(doc_path).name:16} {pos:6} seed={seed} "
                          f"{'PASSED' if survived else 'dropped'}", flush=True)

    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

    by = defaultdict(lambda: [0, 0])
    for r in rows:
        by[r["probe"]][0] += r["survived"]
        by[r["probe"]][1] += 1
    print(f"\nmodel: {cfg.model} ({cfg.backend})\nprobe                  survived")
    for pid, (s, n) in sorted(by.items(), key=lambda kv: -kv[1][0] / kv[1][1]):
        print(f"{pid:22} {s}/{n}")
    print(f"\nfull summaries: {args.out}")


if __name__ == "__main__":
    main()
