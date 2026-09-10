# Optional: running StayQuiet's agent on Amazon Bedrock AgentCore Runtime

The submitted product is the container in the repository root (`Dockerfile`,
`python -m src.stayquiet`). This directory is an additional, optional host for the *same*
Strands agent and the *same* six tools — nothing here is a second implementation.

## Local check

```bash
pip install -r deploy/agentcore/requirements.txt
python deploy/agentcore/main.py
# in another terminal:
curl -s -X POST localhost:8080/invocations -H 'content-type: application/json' \
  -d '{"action":"cycle"}'
```

## Deploying

AWS ships two toolchains for AgentCore Runtime, and which one applies depends on the version
installed:

* **AgentCore CLI (npm, current):** `npm install -g @aws/agentcore`, then `agentcore create` in a
  scratch directory choosing framework **Strands Agents**, copy this `main.py` over the generated
  entrypoint together with `src/` and `engine/`, then `agentcore deploy` and
  `agentcore invoke --prompt "…"`. Check status with `agentcore status`.
* **Starter toolkit (pip, earlier):** `pip install bedrock-agentcore-starter-toolkit`, then
  `agentcore configure --entrypoint deploy/agentcore/main.py`, `agentcore launch`,
  `agentcore invoke '{"action":"cycle"}'`.

Both need AWS credentials and Bedrock model access. If neither is available, skip this directory:
the product's own container is the submitted deployment.
