"""Insert a template's payload into a document, the same way a run does (used by the viewer's preview).

  echo '{"doc": "...", "template_id": "t1", "position": "middle"}' | python scripts/inject_doc.py

Prints {"ok": true, "text": "..."} or {"ok": false, "error": "..."}.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from m117.attacks import TemplateError, get_template, inject  # noqa: E402


def main() -> None:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        req = json.loads(sys.stdin.read())
        t = get_template(req["template_id"])
        out = {"ok": True, "text": inject(req["doc"], t["text"], req["position"]), "marker": t.get("marker", "")}
    except (TemplateError, KeyError, TypeError, json.JSONDecodeError) as e:
        out = {"ok": False, "error": str(e)}
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0 if out["ok"] else 1)


if __name__ == "__main__":
    main()
