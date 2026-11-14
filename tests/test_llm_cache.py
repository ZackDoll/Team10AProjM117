from m117.config import Config
from m117.llm import AnthropicClient, BudgetExceeded, CostMeter, DiskCache

import pytest


class FakeBlock:
    def __init__(self, d): self.d = d
    def model_dump(self, **_): return self.d


class FakeUsage:
    def model_dump(self): return {"input_tokens": 1000, "output_tokens": 100}


class FakeResp:
    content = [FakeBlock({"type": "text", "text": "hi"})]
    stop_reason = "end_turn"
    usage = FakeUsage()


class FakeMessages:
    def __init__(self): self.calls = []
    def create(self, **kw):
        self.calls.append(kw)
        return FakeResp()


def make(tmp_path, budget=1.0):
    cfg = Config(backend="anthropic", model="claude-haiku-5-5", cache_dir=str(tmp_path),
                 prices_per_mtok={"claude-haiku-5-5": [0.10, 0.50]}, budget_usd=budget)
    c = AnthropicClient.__new__(AnthropicClient)
    c.model, c.config, c.cache = cfg.model, cfg, DiskCache(tmp_path)
    c.meter = CostMeter(cfg.budget_usd, cfg.prices_per_mtok)
    c.client = type("C", (), {"messages": FakeMessages()})()
    return c


def test_cache_hit_on_same_seed_miss_on_new_seed(tmp_path):
    c = make(tmp_path)
    kw = dict(system="s", messages=[{"role": "user", "content": "x"}], tools=None, agent="reader")
    a = c.complete(seed=1, **kw)
    b = c.complete(seed=1, **kw)
    d = c.complete(seed=2, **kw)
    assert not a.cached and b.cached and not d.cached
    assert len(c.client.messages.calls) == 2
    assert "temperature" not in c.client.messages.calls[0]
    assert c.client.messages.calls[0]["output_config"] == {"effort": "low"}


def test_budget_enforced(tmp_path):
    c = make(tmp_path, budget=0.0001)
    with pytest.raises(BudgetExceeded):
        c.complete(system="s", messages=[{"role": "user", "content": "x"}], tools=None, seed=1, agent="r")
