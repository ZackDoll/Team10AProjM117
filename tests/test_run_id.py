import pytest

from conftest import read_events
from m117.config import Config
from m117.llm import StubClient
from m117.pipeline import effective_model, make_run_id, model_slug, run


@pytest.mark.parametrize("model, slug", [
    ("claude-haiku-5-5", "claude-haiku-5-5"),
    ("qwen2.5:3b-instruct", "qwen2.5-3b-instruct"),
    ("stub", "stub"),
    ("org/Model_v2 (beta)", "org-Model-v2-beta"),
    ("a__b", "a-b"),            # never a double underscore: ids are split on it
    ("::", "unknown"),
    ("", "unknown"),
])
def test_model_slug_is_filename_safe(model, slug):
    assert model_slug(model) == slug
    assert "__" not in model_slug(model)


def test_run_id_keeps_the_first_five_fields_and_appends_the_model():
    rid = make_run_id("chain", "d1", "direct_override", "middle", 3, "qwen2.5:3b-instruct")
    assert rid == "chain__d1__direct_override__middle__s3__qwen2.5-3b-instruct"
    assert rid.split("__")[:5] == ["chain", "d1", "direct_override", "middle", "s3"]
    assert make_run_id("chain", "d1", None, None, 1, "stub") == "chain__d1__clean__na__s1__stub"


def test_the_stub_backend_ignores_the_configured_model():
    assert effective_model(Config(backend="stub", model="claude-haiku-5-5")) == "stub"
    assert effective_model(Config(backend="ollama", model="qwen2.5:3b-instruct")) == "qwen2.5:3b-instruct"
    assert effective_model(Config(backend="anthropic", model="claude-haiku-5-5")) == "claude-haiku-5-5"


class OtherModel(StubClient):
    def __init__(self, config):
        super().__init__(config)
        self.model = "other:7b"


def test_the_same_combination_on_two_models_makes_two_logs(stub_config, clean_doc):
    a = run(stub_config, topology="chain", doc_id="d1", doc_text=clean_doc, seed=1)
    b = run(stub_config, topology="chain", doc_id="d1", doc_text=clean_doc, seed=1, llm=OtherModel(stub_config))
    assert a != b and a.is_file() and b.is_file()
    assert a.stem == "chain__d1__clean__na__s1__stub" and b.stem == "chain__d1__clean__na__s1__other-7b"
    ea, eb = read_events(a), read_events(b)
    assert ea[0]["run_id"] == a.stem and eb[0]["run_id"] == b.stem and eb[0]["model"] == "other:7b"
    assert ea[0]["canary"] != eb[0]["canary"]  # the canary is derived from the run id
    assert (stub_config.log_dir and (a.parent.parent / "transcripts" / f"{b.stem}.md").is_file())


def test_rerunning_on_the_same_model_replaces_the_log(stub_config, clean_doc):
    a = run(stub_config, topology="chain", doc_id="d1", doc_text=clean_doc, seed=1)
    b = run(stub_config, topology="chain", doc_id="d1", doc_text=clean_doc, seed=1)
    assert a == b
