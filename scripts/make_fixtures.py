"""Regenerate the stub sample logs the evaluation pair builds the checker against."""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from m117.config import Config  # noqa: E402
from m117.pipeline import run  # noqa: E402

out = ROOT / "tests" / "fixtures"
cfg = Config(backend="stub", model="stub", log_dir=str(ROOT / "logs" / "fixtures"))
clean = (ROOT / "data/placeholder/d1.txt").read_text(encoding="utf-8")
poisoned = (ROOT / "data/placeholder/d1_poisoned_example.txt").read_text(encoding="utf-8")
for topo in ("chain", "orchestrator"):
    for name, doc, tmpl, pos in (("clean", clean, None, None), ("leak", poisoned, "stubtest", "middle")):
        p = run(cfg, topology=topo, doc_id="d1", doc_text=doc, seed=1, template_id=tmpl, position=pos)
        shutil.copy(p, out / f"sample_{topo}_{name}.jsonl")
        print(out / f"sample_{topo}_{name}.jsonl")
