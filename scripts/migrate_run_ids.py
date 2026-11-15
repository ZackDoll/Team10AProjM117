"""Rename run logs written before the model was part of the run id.

  python scripts/migrate_run_ids.py --dry-run     show what would change
  python scripts/migrate_run_ids.py               do it

For each logs/runs/<id>.jsonl without a model suffix this writes logs/runs/<id>__<model>.jsonl (the
model is read from the log itself), rewrites the run_id on every line, rebuilds the transcript and
removes the old files. The canary stays as it was logged. Logs that already have the suffix are left
alone, and a log is skipped if its new name is taken.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from m117.pipeline import model_slug  # noqa: E402
from m117.transcript import read_events, write_transcript  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--log-dir", type=Path, default=ROOT / "logs")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    runs = a.log_dir / "runs"
    moved = skipped = already = 0
    for path in sorted(runs.glob("*.jsonl")):
        try:
            events = read_events(path)
            start = next(e for e in events if e["event"] == "run_start")
            rid, model = start["run_id"], str(start["model"])
        except (StopIteration, KeyError, json.JSONDecodeError, OSError) as e:
            print(f"skip   {path.name}: not a run log ({type(e).__name__})")
            skipped += 1
            continue
        suffix = "__" + model_slug(model)
        if rid.endswith(suffix):
            already += 1
            continue
        new = rid + suffix
        target = runs / f"{new}.jsonl"
        if target.exists():
            print(f"skip   {path.name}: {target.name} already exists")
            skipped += 1
            continue
        print(f"{'would ' if a.dry_run else ''}rename {rid}  ->  {new}")
        if a.dry_run:
            moved += 1
            continue
        for e in events:
            e["run_id"] = new
        target.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events), encoding="utf-8", newline="\n")
        write_transcript(target, a.log_dir / "transcripts")
        path.unlink()
        (a.log_dir / "transcripts" / f"{rid}.md").unlink(missing_ok=True)
        moved += 1
    print(f"\n{moved} {'to rename' if a.dry_run else 'renamed'}, {already} already had the model, {skipped} skipped")


if __name__ == "__main__":
    main()
