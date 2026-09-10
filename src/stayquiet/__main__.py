# StayQuiet — `python -m src.stayquiet` starts the whole product on one port.
# PORT (default 8080) and HOST (default 0.0.0.0) come from the environment so the
# container needs no arguments.
from __future__ import annotations

import os

import uvicorn


def main() -> None:
    """Serve src.stayquiet.api:app with uvicorn. Blocks until interrupted."""
    uvicorn.run(
        "src.stayquiet.api:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8080")),
        log_level=os.environ.get("LOG_LEVEL", "info"),
        access_log=False,
    )


if __name__ == "__main__":
    main()
