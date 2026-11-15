"""Validate a pipeline spec with the same code the runner uses.

  python scripts/validate_pipeline.py pipelines/custom/mine.json
  cat spec.json | python scripts/validate_pipeline.py -      (the viewer's server does this)

Prints one JSON object: {"ok": bool, "errors": [...], "warnings": [...]}. Exit code 0 if valid.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from m117.spec import SpecError, validate  # noqa: E402


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    try:
        if sys.argv[1] == "-":
            sys.stdin.reconfigure(encoding="utf-8")
            text = sys.stdin.read()
        else:
            text = Path(sys.argv[1]).read_text(encoding="utf-8")
        spec = json.loads(text)
        warnings = validate(spec)
        result = {"ok": True, "errors": [], "warnings": warnings}
    except SpecError as e:
        result = {"ok": False, "errors": str(e).split("; "), "warnings": []}
    except (OSError, json.JSONDecodeError) as e:
        result = {"ok": False, "errors": [f"could not read the pipeline: {e}"], "warnings": []}
    print(json.dumps(result))
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
