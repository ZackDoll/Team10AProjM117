"""Build markdown transcripts for run logs that already exist.

  python scripts/make_transcript.py logs/runs/chain__d1__clean__na__s1.jsonl
  python scripts/make_transcript.py logs/runs/*.jsonl          (all of them)
  python scripts/make_transcript.py --out docs/transcripts logs/runs/x.jsonl

New runs write their own transcript to logs/transcripts/ automatically; this is for older logs.
Logs from before the `pipeline` field was added work too, but have no system prompts section.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from m117.transcript import write_transcript  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("logs", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, default=ROOT / "logs" / "transcripts")
    a = ap.parse_args()
    for p in a.logs:
        try:
            print(write_transcript(p, a.out))
        except Exception as e:
            print(f"skipped {p}: {type(e).__name__}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
