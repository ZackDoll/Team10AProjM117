"""Regenerate the stub sample logs (and their transcripts) the evaluation pair builds the checker against."""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from m117.config import Config  # noqa: E402
from m117.llm import StubClient  # noqa: E402
from m117.pipeline import run  # noqa: E402
from m117.transcript import read_events, render_markdown  # noqa: E402

out = ROOT / "tests" / "fixtures"
log_dir = ROOT / "logs" / "fixtures"
cfg = Config(backend="stub", model="stub", log_dir=str(log_dir))
clean = (ROOT / "data/placeholder/d1.txt").read_text(encoding="utf-8")
poisoned = (ROOT / "data/placeholder/d1_poisoned_example.txt").read_text(encoding="utf-8")
for topo in ("chain", "orchestrator"):
    for name, doc, tmpl, pos in (("clean", clean, None, None), ("leak", poisoned, "stubtest", "middle")):
        p = run(cfg, topology=topo, doc_id="d1", doc_text=doc, seed=1, template_id=tmpl, position=pos)
        shutil.copy(p, out / f"sample_{topo}_{name}.jsonl")
        shutil.copy(log_dir / "transcripts" / f"{p.stem}.md", out / f"sample_{topo}_{name}.md")
        print(out / f"sample_{topo}_{name}.jsonl")


# A run that fails part-way, so the viewer and the transcript show an error. The traceback is
# replaced by a fixed one so no local paths end up in the repo.
class FailsOnSecondCall(StubClient):
    calls = 0

    def complete(self, **kw):
        FailsOnSecondCall.calls += 1
        if FailsOnSecondCall.calls == 2:
            raise RuntimeError("simulated model failure")
        return super().complete(**kw)


try:
    run(cfg, topology="chain", doc_id="d1", doc_text=clean, seed=2, llm=FailsOnSecondCall(cfg))
except RuntimeError:
    pass
src = log_dir / "runs" / "chain__d1__clean__na__s2.jsonl"
events = read_events(src)
for e in events:
    if e["event"] == "error":
        e["detail"] = "Traceback (most recent call last):\n  ...\nRuntimeError: simulated model failure\n"
(out / "sample_chain_error.jsonl").write_text(
    "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events), encoding="utf-8", newline="\n")
(out / "sample_chain_error.md").write_text(render_markdown(events), encoding="utf-8", newline="\n")
print(out / "sample_chain_error.jsonl")
