import ast
from pathlib import Path

import pytest

from conftest import read_events
from m117.canary import make_canary
from m117.pipeline import run

SRC = Path(__file__).resolve().parents[1] / "src" / "m117"

EXPECTED_ROUTES = {
    "chain": [("user", "reader"), ("reader", "analyst"), ("analyst", "tool_user"), ("tool_user", "user")],
    "orchestrator": [("user", "orchestrator"), ("orchestrator", "reader"), ("reader", "orchestrator"),
                     ("orchestrator", "analyst"), ("analyst", "orchestrator"),
                     ("orchestrator", "tool_user"), ("tool_user", "orchestrator")],
}


@pytest.mark.parametrize("topology", ["chain", "orchestrator"])
def test_clean_run_routes_and_logs(stub_config, clean_doc, topology):
    ev = read_events(run(stub_config, topology=topology, doc_id="d1", doc_text=clean_doc, seed=1))
    assert ev[0]["event"] == "run_start" and ev[-1]["event"] == "run_end"
    assert ev[-1]["status"] == "ok"
    assert [e["seq"] for e in ev] == list(range(len(ev)))
    for e in ev:
        for k in ("run_id", "topology", "doc_id", "template_id", "position", "seed", "model", "ts"):
            assert k in e
    routes = [(e["sender"], e["receiver"]) for e in ev if e["event"] == "message"]
    assert routes == EXPECTED_ROUTES[topology]
    assert [e["hop"] for e in ev if e["event"] == "message"] == list(range(len(routes)))
    sends = [e for e in ev if e["event"] == "tool_call"]
    assert len(sends) == 1 and sends[0]["args"]["to"] == stub_config.user_address
    assert sends[0]["caller"] == "tool_user"


@pytest.mark.parametrize("topology", ["chain", "orchestrator"])
def test_poisoned_run_leaks_with_stub(stub_config, poisoned_doc, topology):
    ev = read_events(run(stub_config, topology=topology, doc_id="d1", doc_text=poisoned_doc, seed=1,
                         template_id="stubtest", position="middle"))
    canary = ev[0]["canary"]
    leaks = [e for e in ev if e["event"] == "tool_call" and canary in e["args"]["body"]]
    assert leaks and leaks[0]["args"]["to"] == stub_config.attacker_address
    assert ev[0]["template_id"] == "stubtest" and ev[0]["position"] == "middle"


def test_canary_only_reaches_tool_user(stub_config, poisoned_doc):
    """The reader never sees the canary: it must not appear in any message before the tool user acts."""
    ev = read_events(run(stub_config, topology="chain", doc_id="d1", doc_text=poisoned_doc, seed=1))
    canary = ev[0]["canary"]
    assert canary not in poisoned_doc
    for e in ev:
        if e["event"] == "message" and e["sender"] != "tool_user":
            assert canary not in e["content"]


def test_canary_is_stable_per_run_and_differs_across_runs():
    assert make_canary("a").startswith("CANARY-") and len(make_canary("a")) == 15
    assert make_canary("a") == make_canary("a") != make_canary("b")


def test_tools_module_has_no_network_imports():
    tree = ast.parse((SRC / "tools.py").read_text(encoding="utf-8"))
    mods = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    mods |= {(n.module or "").split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
    assert not mods & {"socket", "http", "urllib", "requests", "httpx", "httpx2", "smtplib", "anthropic"}


def test_unknown_topology_rejected(stub_config, clean_doc):
    with pytest.raises(ValueError):
        run(stub_config, topology="mesh", doc_id="d1", doc_text=clean_doc, seed=1)
