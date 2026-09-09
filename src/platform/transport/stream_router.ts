// Requirement IDs: TRN-02, TRN-03, GOV-RES-01 | Backend route wiring (DP-B §4.2.1)
// ILLUSTRATIVE WIRING — shows how a Node HTTP router exposes the SSE publisher
// at GET /events/stream (Express/Fastify equivalents attach identically via
// asSseStream). Application code imports only from src/platform/transport
// (GOV-REU-03); this file documents the server-side attachment pattern used by
// tests (TRN-AC-01/02). Uses structural http types so no framework dep is
// required in the platform layer.
import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createPublisher } from "./index.js";
import type { CollectablePublisher } from "./index.js";

/**
 * Mount the event endpoints on an existing node:http request handler:
 *   GET /events/stream → SSE fanout (TRN-03)
 *   GET /events        → non-streaming fallback snapshot (TRN-RES-03, §4.6)
 * Switching TRANSPORT requires no call-site edit (GOV-REU-01): both routes are
 * served from the same transport-agnostic publisher facade.
 */
export function handleEventStream(
  publisher: CollectablePublisher,
): (req: IncomingMessage, res: ServerResponse) => void {
  // media_type text/event-stream equivalent for Node: headers are set by the
  // SSE adapter (Content-Type: text/event-stream, Cache-Control: no-cache).
  return (req, res) => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    if (url === "/events") {
      // TRN-RES-03 synchronous final response — same envelope contract (TRN-06).
      const traceId = new URL(req.url ?? "/events", "http://localhost").searchParams.get("trace_id") ?? undefined;
      const snapshot = publisher.collect(traceId ?? undefined);
      if (!snapshot) {
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "no events collected" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(JSON.stringify(snapshot));
      return;
    }
    if (!req.url || !req.url.startsWith("/events/stream")) {
      res.writeHead(404).end();
      return;
    }
    publisher.asSseStream(req, res); // one fanout connection per client (TRN-RES-01)
    req.on("close", () => console.debug("[events] client detached"));
  };
}

/** Example bootstrap (illustrative only — not executed by library consumers). */
export function createExampleServer(): Server {
  const publisher = createPublisher() as CollectablePublisher;
  return http.createServer(handleEventStream(publisher));
}
