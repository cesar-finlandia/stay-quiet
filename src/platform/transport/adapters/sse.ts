// Requirement IDs: TRN-03, TRN-04, TRN-05, TRN-RES-01 | SSE adapter (DP-B §4.3, §4.4)
// INTERNAL ADAPTER — GOV-REU-03: consumers never import this file. Application
// code goes through createPublisher()/createSubscriber() in src/platform/transport.
//
// Isolation contract (TRN-RES-01 / GOV-RES-04): each connection write is
// try/catch-guarded; a broken client (EPIPE/abort) is removed from the fanout
// set and never throws into the publisher or other subscribers. Fanout uses
// Promise.allSettled-style semantics so one dead connection cannot block the
// rest. Cooperative backpressure (§4.3): publish awaits the underlying flush
// (res.write false → "drain") before resolving.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventEnvelope } from "../event-envelope.js";

/** One connected SSE client. */
export interface SseConnection {
  readonly id: number;
  /** Write one envelope as an SSE frame; resolves when flushed/drain-ready. */
  write(envelope: EventEnvelope): Promise<void>;
  /** Terminate the stream for this client. */
  end(): void;
}

/**
 * SSE framing per DP-B §4.3 — one event per envelope:
 *   id: <sequence>
 *   event: envelope
 *   data: <json>\n\n
 */
export function formatSseFrame(envelope: EventEnvelope): string {
  return `id: ${envelope.sequence}\nevent: envelope\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/** Fan-out hub owned by the SSE publisher adapter. */
export class SseHub {
  private nextId = 1;
  private readonly connections = new Set<SseConnection>();

  /** Attach an HTTP response as an SSE stream; returns the registered connection. */
  attach(req: IncomingMessage, res: ServerResponse): SseConnection {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");

    const connection: SseConnection = {
      id: this.nextId++,
      write: async (envelope: EventEnvelope) => {
        // Guarded per §4.4 — a throw here is caught by the hub fanout, which
        // removes this connection only.
        const ok = res.write(formatSseFrame(envelope));
        if (!ok) {
          await new Promise<void>((resolve) => {
            const onDrain = () => {
              res.off("drain", onDrain);
              resolve();
            };
            res.once("drain", onDrain);
          });
        }
      },
      end: () => {
        try {
          res.end();
        } catch {
          /* already gone */
        }
      },
    };

    this.connections.add(connection);
    req.on("close", () => this.remove(connection));
    res.on("error", () => this.remove(connection));
    return connection;
  }

  remove(connection: SseConnection): void {
    if (!this.connections.has(connection)) return;
    this.connections.delete(connection);
    connection.end();
    // debug-level by convention (§4.4) — no logger dependency in platform layer
    console.debug(`[sse] connection ${connection.id} removed`);
  }

  get size(): number {
    return this.connections.size;
  }

  /**
   * Fan out to all connections with allSettled-style isolation: every write is
   * attempted, failures remove only their own connection, and no rejection ever
   * escapes to the publisher (TRN-RES-01).
   */
  async fanout(envelope: EventEnvelope): Promise<void> {
    const results = await Promise.allSettled(
      [...this.connections].map(async (connection) => {
        try {
          await connection.write(envelope);
        } catch {
          this.remove(connection);
        }
      }),
    );
    void results; // allSettled: never inspect/propagate rejections
  }

  async close(): Promise<void> {
    for (const connection of [...this.connections]) {
      this.remove(connection);
    }
  }
}
