# StayQuiet — optional Amazon Bedrock AgentCore Runtime entrypoint.
#
# The submitted product is the container in the repository root; this file exists so
# the SAME Strands agent, with the SAME six tools, can also be hosted on AgentCore
# Runtime, which the hackathon rules call out as strengthening Technical
# Implementation. It adds nothing to the product and is not required to run it.
#
# Local check:   python deploy/agentcore/main.py        # serves on :8080
# Deploy:        see deploy/agentcore/README.md
#
# It reuses build_agent() (DP-MODEL) and ALL_TOOLS (DP-TOOLS) — there is no second
# agent definition anywhere in this repository.
from __future__ import annotations

from bedrock_agentcore.runtime import BedrockAgentCoreApp

from engine.agents.stayquiet_agent import load_prompt, run_cycle
from engine.tools import ALL_TOOLS
from src.stayquiet.model import build_agent, result_text

app = BedrockAgentCoreApp()
_agent = build_agent(tools=ALL_TOOLS, system_prompt=load_prompt("system.stayquiet.md"))


@app.entrypoint
def invoke(payload: dict) -> dict:
    """Two modes, chosen by the payload.

    {"action": "cycle"}            → run one full background cycle and return its summary
    {"prompt": "<text>"}           → one turn of the same agent, with the same tools
    """
    if str(payload.get("action", "")).lower() == "cycle":
        result = run_cycle()
        return {
            "summary": result["summary"],
            "bookings_affected": result["bookings_affected"],
            "decisions": [
                {"booking_id": d["booking_id"], "kind": d["kind"], "summary": d["summary"]}
                for d in result["decisions"]
            ],
            "quiet_actions": result["quiet_actions"],
            "degraded": result["degraded"],
        }
    prompt = str(payload.get("prompt") or "Summarise what changed in the policy and who it affects.")
    return {"result": result_text(_agent(prompt))}


if __name__ == "__main__":
    app.run()
