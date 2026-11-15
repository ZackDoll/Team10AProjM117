"""The 100 generated input documents in data/docs/."""
import collections
import json
import re
import subprocess
import sys

import pytest

from conftest import ROOT
from m117.attacks import POSITIONS, inject, load_templates

sys.path.insert(0, str(ROOT / "scripts"))
from make_documents import CITIES  # noqa: E402

DOCS = ROOT / "data" / "docs"
MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"
MANIFEST = json.loads((DOCS / "manifest.json").read_text(encoding="utf-8"))
ANSWERS = json.loads((DOCS / "answers.json").read_text(encoding="utf-8"))
IDS = [d["id"] for d in MANIFEST]


def text(doc_id):
    return (DOCS / f"{doc_id}.txt").read_text(encoding="utf-8")


def test_there_are_100_documents_in_three_lengths():
    assert len(MANIFEST) == 100 and len(set(IDS)) == 100
    assert collections.Counter(d["tier"] for d in MANIFEST) == {"short": 30, "medium": 40, "long": 30}
    assert sorted(p.stem for p in DOCS.glob("d[0-9][0-9][0-9]_*.txt")) == sorted(IDS)
    words = {t: [d["words"] for d in MANIFEST if d["tier"] == t] for t in ("short", "medium", "long")}
    assert max(words["short"]) < min(words["medium"]) and max(words["medium"]) < min(words["long"])
    assert min(words["short"]) >= 60 and max(words["long"]) >= 500  # genuinely short and genuinely long ones


@pytest.mark.parametrize("doc_id", IDS)
def test_every_document_can_host_a_payload_in_three_different_places(doc_id):
    doc = text(doc_id)
    paras = doc.strip().split("\n\n")
    assert len(paras) >= 4
    variants = {pos: inject(doc, "PAYLOAD", pos) for pos in POSITIONS}
    assert len(set(variants.values())) == 3
    at = {pos: v.strip().split("\n\n").index("PAYLOAD") for pos, v in variants.items()}
    assert at["start"] == 0 and 0 < at["middle"] < len(paras) and at["end"] == len(paras)
    meta = next(d for d in MANIFEST if d["id"] == doc_id)
    assert meta["paragraphs"] == len(paras) and meta["words"] == len(doc.split())
    assert "{" not in doc and "[[" not in doc and "  " not in doc  # no unfilled template pieces


@pytest.mark.parametrize("doc_id", IDS)
def test_the_answer_key_is_present_and_unambiguous(doc_id):
    doc, key = text(doc_id), ANSWERS[doc_id]
    assert len(key) == 4 and all(isinstance(a, list) and a for a in key)
    for accepted in key:
        assert accepted[0] in doc, f"{doc_id}: {accepted[0]!r} not in the document"
    amounts = set(re.findall(r"\$\d{1,3}(?:,\d{3})*(?:\.\d+)?(?: million| billion)?", doc))
    assert amounts == {key[2][0]}, f"{doc_id}: exactly one dollar amount expected, got {amounts}"
    dates = set(re.findall(rf"(?:{MONTHS}) \d{{1,2}}, \d{{4}}", doc))
    assert dates == {key[1][0]}, f"{doc_id}: exactly one full date expected, got {dates}"
    assert len(set(re.findall(rf"\b(?:{MONTHS})\b", doc))) == 1  # no other month is mentioned
    city = key[3][0]
    others = [c for c, _ in CITIES if c != city and re.search(rf"{re.escape(c)}", doc)]
    assert not others, f"{doc_id}: other places mentioned besides {city}: {others}"


def test_organizations_are_unique_and_the_org_is_the_subject():
    orgs = [ANSWERS[i][0][0] for i in IDS]
    assert len(set(orgs)) == 100
    for i in IDS:
        assert text(i).count(ANSWERS[i][0][0]) >= 2  # it is what the document is mainly about


def test_every_document_is_assigned_a_real_template_and_a_position():
    ids = {t["id"] for t in load_templates()}
    for d in MANIFEST:
        assert d["assigned_template"] in ids and not d["assigned_template"].startswith("stub")
        assert d["assigned_position"] in POSITIONS


def test_the_assignments_are_balanced():
    pairs = collections.Counter((d["assigned_template"], d["assigned_position"]) for d in MANIFEST)
    per_template = collections.Counter(d["assigned_template"] for d in MANIFEST)
    per_position = collections.Counter(d["assigned_position"] for d in MANIFEST)
    assert max(pairs.values()) - min(pairs.values()) <= 1  # every template x position used 3 times (one 4)
    assert max(per_template.values()) - min(per_template.values()) <= 3
    assert max(per_position.values()) - min(per_position.values()) <= 4
    # and spread over lengths: every template meets short, medium and long documents
    for t in per_template:
        assert {d["tier"] for d in MANIFEST if d["assigned_template"] == t} == {"short", "medium", "long"}


def test_generation_is_deterministic(tmp_path):
    out = tmp_path / "docs"
    subprocess.run([sys.executable, str(ROOT / "scripts" / "make_documents.py"), "--out", str(out)], check=True,
                   capture_output=True)
    for name in ["manifest.json", "answers.json", IDS[0] + ".txt", IDS[57] + ".txt", IDS[99] + ".txt"]:
        assert (out / name).read_bytes() == (DOCS / name).read_bytes(), name
