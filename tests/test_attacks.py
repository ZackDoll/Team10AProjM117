import json

import pytest

from m117.attacks import POSITIONS, TemplateError, get_template, inject, load_templates

DOC = "Title\n\nPara one.\n\nPara two.\n\nPara three.\n"


def test_inject_positions_make_the_payload_its_own_paragraph():
    assert inject(DOC, "PAYLOAD", "start").split("\n\n")[0] == "PAYLOAD"
    assert inject(DOC, "PAYLOAD", "end").rstrip("\n").split("\n\n")[-1] == "PAYLOAD"
    mid = inject(DOC, "PAYLOAD", "middle").split("\n\n")
    assert mid.index("PAYLOAD") == 2 and mid[1] == "Para one." and mid[3] == "Para two."
    for pos in POSITIONS:
        out = inject(DOC, "  PAYLOAD  ", pos)
        assert "PAYLOAD" in out and out.endswith("\n") and "Para three." in out


def test_inject_rejects_a_bad_position():
    with pytest.raises(TemplateError):
        inject(DOC, "x", "top")


def test_the_shipped_templates_load_and_have_markers():
    ts = load_templates()
    assert len(ts) >= 2
    ids = [t["id"] for t in ts]
    assert len(ids) == len(set(ids))
    for t in ts:
        assert t["text"].strip() and t.get("marker"), t["id"]
        assert t["marker"] in t["text"], f"{t['id']}: the marker should appear in the payload"
    assert get_template(ids[0]) == ts[0]


@pytest.mark.parametrize("bad, msg", [
    ("not json", "not valid JSON"),
    ('{"id": "a"}', "must be a JSON list"),
    ('["x"]', "must be an object"),
    ('[{"id": "bad id", "text": "t"}]', "id must be"),
    ('[{"id": "a__b", "text": "t"}]', "id must be"),
    ('[{"id": "a", "text": " "}]', "text is empty"),
    ('[{"id": "a", "text": "t"}, {"id": "a", "text": "u"}]', "duplicate template id"),
    ('[{"id": "a", "text": "t", "marker": 5}]', "marker must be a string"),
])
def test_bad_template_files_are_rejected(tmp_path, bad, msg):
    p = tmp_path / "t.json"
    p.write_text(bad, encoding="utf-8")
    with pytest.raises(TemplateError, match=msg):
        load_templates(p)


def test_missing_file_and_unknown_template(tmp_path):
    with pytest.raises(TemplateError, match="No templates file"):
        load_templates(tmp_path / "nope.json")
    p = tmp_path / "t.json"
    p.write_text(json.dumps([{"id": "a", "text": "t"}]), encoding="utf-8")
    with pytest.raises(TemplateError, match="unknown template"):
        get_template("zzz", p)
