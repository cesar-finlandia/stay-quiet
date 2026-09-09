# TODO(ENGINE): implement your agent call — this wrapper is already demo-proof (see docs/engine-guide.md)
from src.resilience import with_resilience


def _call_agent(input_data):
    # TODO(ENGINE): replace with real LLM/agent call
    raise NotImplementedError("ENGINE_TODO: agent not yet implemented")


# RES-01 wrapping is config-only: keep the wrapper + config, replace the body above.
call_agent = with_resilience(
    _call_agent,
    {"timeout_ms": 15000, "retries": 1, "fallback_chain": {"order": ["cache", "none"]}},
)
