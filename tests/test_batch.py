import json
import subprocess
import sys

from conftest import ROOT

SCRIPT = ROOT / "scripts" / "run_batch.py"


def batch(tmp_path, *args):
    cfg = tmp_path / "cfg.yaml"
    cfg.write_text(f"backend: stub\nmodel: stub\nlog_dir: {(tmp_path / 'logs').as_posix()}\n"
                   f"cache_dir: {(tmp_path / 'cache').as_posix()}\n", encoding="utf-8")
    p = subprocess.run([sys.executable, str(SCRIPT), "--config", str(cfg), "--json",
                        "--docs", str(ROOT / "data/placeholder/d1.txt"), *args],
                       capture_output=True, text=True, encoding="utf-8")
    events = [json.loads(l) for l in p.stdout.splitlines() if l.startswith("{")]
    return p.returncode, events


def test_batch_runs_the_matrix_and_scores_each_run(tmp_path):
    code, ev = batch(tmp_path, "--template-ids", "stubtest", "direct_override", "--positions", "middle",
                     "--pipelines", "chain", "orchestrator", "--seeds", "3", "--with-clean")
    assert code == 0
    assert ev[0]["event"] == "plan" and ev[0]["total"] == 6 and ev[0]["overwrites"] == []
    runs = [e for e in ev if e["event"] == "run"]
    assert [r["i"] for r in runs] == list(range(1, 7))
    attacks = [r for r in runs if r["template"]]
    clean = [r for r in runs if not r["template"]]
    assert len(attacks) == 4 and len(clean) == 2
    assert all(r["leaked"] and r["leaked_to"] == "attacker@evil.example" for r in attacks)  # the stub obeys payloads
    assert not any(r["leaked"] for r in clean) and all(r["report_sent"] for r in clean)
    assert ev[-1] == {"event": "summary", "ran": 6, "attack_runs": 4, "leaks": 4, "spent_usd": 0.0}
    # each run is announced just before it starts, so the viewer can mark it as the current one
    for k, e in enumerate(ev):
        if e["event"] == "run":
            assert ev[k - 1] == {"event": "start", "i": e["i"], "run_id": e["run_id"]}
    assert (tmp_path / "logs" / "runs" / "chain__d1__stubtest__middle__s3__stub.jsonl").is_file()
    assert (tmp_path / "logs" / "transcripts" / "chain__d1__stubtest__middle__s3__stub.md").is_file()


def test_a_second_batch_warns_about_the_logs_it_will_overwrite(tmp_path):
    args = ("--template-ids", "stubtest", "--pipelines", "chain", "--seeds", "1")
    batch(tmp_path, *args)
    _, ev = batch(tmp_path, *args)
    assert ev[0]["overwrites"] == ["chain__d1__stubtest__middle__s1__stub"]


def test_dry_run_writes_nothing(tmp_path):
    code, ev = batch(tmp_path, "--template-ids", "stubtest", "--pipelines", "chain", "--dry-run")
    assert code == 0 and [e["event"] for e in ev] == ["plan", "run"] and ev[1]["dry_run"]
    assert not (tmp_path / "logs").exists()


def test_the_run_cap_and_bad_input_stop_the_batch_before_it_starts(tmp_path):
    code, ev = batch(tmp_path, "--positions", "start", "middle", "end", "--seeds", "1", "2", "3")  # 12 x 3 x 3 x 2 > 20
    assert code == 1 and ev[-1]["event"] == "error" and "--max-runs" in ev[-1]["error"]
    code, ev = batch(tmp_path, "--template-ids", "nope")
    assert code == 1 and "unknown template" in ev[-1]["error"]
    code, ev = batch(tmp_path, "--pipelines", "mesh")
    assert code == 1 and "unknown pipeline" in ev[-1]["error"]
    assert not (tmp_path / "logs").exists()


def test_assigned_mode_runs_each_document_with_its_own_poison(tmp_path):
    manifest = {d["id"]: d for d in json.loads((ROOT / "data/docs/manifest.json").read_text(encoding="utf-8"))}
    ids = ["d001_medium", "d002_long", "d006_short"]
    docs = [str(ROOT / f"data/docs/{i}.txt") for i in ids]
    cfg = tmp_path / "cfg.yaml"
    cfg.write_text(f"backend: stub\nmodel: stub\nlog_dir: {(tmp_path / 'logs').as_posix()}\n"
                   f"cache_dir: {(tmp_path / 'cache').as_posix()}\n", encoding="utf-8")
    p = subprocess.run([sys.executable, str(SCRIPT), "--config", str(cfg), "--json", "--assigned", "--with-clean",
                        "--pipelines", "chain", "--docs", *docs], capture_output=True, text=True, encoding="utf-8")
    ev = [json.loads(l) for l in p.stdout.splitlines() if l.startswith("{")]
    assert p.returncode == 0 and ev[0]["total"] == 6  # 3 poisoned + 3 clean, one pipeline, one seed
    runs = [e for e in ev if e["event"] == "run"]
    for r in runs[:3]:
        m = manifest[r["doc"]]
        assert (r["template"], r["position"]) == (m["assigned_template"], m["assigned_position"])
        assert r["run_id"] == f"chain__{r['doc']}__{m['assigned_template']}__{m['assigned_position']}__s1__stub"
    assert all(r["template"] is None for r in runs[3:])


def test_assigned_mode_rejects_conflicting_flags_and_unassigned_documents(tmp_path):
    base = [sys.executable, str(SCRIPT), "--json", "--assigned", "--dry-run"]
    p = subprocess.run([*base, "--positions", "start", "--docs", str(ROOT / "data/docs/d001_medium.txt")],
                       capture_output=True, text=True, encoding="utf-8")
    assert p.returncode == 1 and "--assigned uses each document's own" in p.stdout
    p = subprocess.run([*base, "--docs", str(ROOT / "data/placeholder/d1.txt")], capture_output=True, text=True, encoding="utf-8")
    assert p.returncode == 1 and "no assigned poison" in p.stdout
