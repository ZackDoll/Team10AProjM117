"""Attack payload templates and where they get inserted into a document.

    data/attacks/templates.json   [{"id": ..., "text": ..., "marker"?: ..., "technique"?: ...}, ...]

`marker` is the phrase to trace through the pipeline to see how far a payload spread (the viewer
fills its marker field from it). `technique` is a free-text note for humans.

inject() is the only implementation of "put this payload at the start, middle or end of the
document": the CLI, the batch runner and the viewer (through scripts/inject_doc.py) all use it.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .spec import ID_RE

ROOT = Path(__file__).resolve().parents[2]
TEMPLATES_PATH = ROOT / "data" / "attacks" / "templates.json"
POSITIONS = ("start", "middle", "end")


class TemplateError(ValueError):
    """The templates file or a request for a template is invalid."""


def load_templates(path: str | Path = TEMPLATES_PATH) -> list[dict[str, Any]]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise TemplateError(f"No templates file at {path}. Create it as a JSON list of "
                            '{"id": ..., "text": ...} objects (the attacks pair writes these).') from None
    except json.JSONDecodeError as e:
        raise TemplateError(f"{path} is not valid JSON: {e}") from None
    if not isinstance(data, list):
        raise TemplateError(f"{path} must be a JSON list")
    seen: set[str] = set()
    for i, t in enumerate(data):
        if not isinstance(t, dict):
            raise TemplateError(f"template #{i + 1} must be an object")
        tid = t.get("id")
        if not isinstance(tid, str) or not ID_RE.fullmatch(tid) or "__" in tid:
            raise TemplateError(f"template #{i + 1}: id must be letters, digits, _ . - (no double underscore)")
        if tid in seen:
            raise TemplateError(f"duplicate template id {tid!r}")
        seen.add(tid)
        if not isinstance(t.get("text"), str) or not t["text"].strip():
            raise TemplateError(f"template {tid!r}: text is empty")
        for opt in ("marker", "technique"):
            if opt in t and not isinstance(t[opt], str):
                raise TemplateError(f"template {tid!r}: {opt} must be a string")
    return data


def get_template(tid: str, path: str | Path = TEMPLATES_PATH) -> dict[str, Any]:
    for t in load_templates(path):
        if t["id"] == tid:
            return t
    raise TemplateError(f"unknown template {tid!r}")


def inject(doc: str, payload: str, position: str) -> str:
    """Insert `payload` as its own paragraph: before the first paragraph (start), in the middle,
    or after the last one (end)."""
    if position not in POSITIONS:
        raise TemplateError(f"position must be one of {list(POSITIONS)}")
    paras = doc.strip().split("\n\n")
    idx = {"start": 0, "middle": len(paras) // 2, "end": len(paras)}[position]
    return "\n\n".join(paras[:idx] + [payload.strip()] + paras[idx:]) + "\n"
