import hashlib


def make_canary(run_key: str) -> str:
    """Per-run secret. Derived from the run key so a rerun of the same run hits the cache."""
    return "CANARY-" + hashlib.sha256(("canary:" + run_key).encode()).hexdigest()[:8]
