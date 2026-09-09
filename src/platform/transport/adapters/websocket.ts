// Requirement IDs: TRN-03, TRN-REU-01, GOV-MIN-01, TRN-RES-01 | WS adapter (DP-B §4.1)
// INTERNAL ADAPTER — GOV-REU-03: consumers never import this file. Application
// code goes through createPublisher()/createSubscriber() in src/platform/transport.
//
// Opt-in transport behind the TRANSPORT knob ("websocket"); SSE remains the
// default. Zero extra dependencies (GOV-MIN-01): the hub is structurally typed
// over a minimal WsSocketLike surface, so any ws-like server object (the `ws`
// package's WebSocket, a browser-side socket, or a test double) attaches
// without this module importing it.
//
// Isolation contract mirrors adapters/sse.ts (TRN-RES-01 / GOV-RES-04): every
// send is try/catch-guarded; a broken socket is removed from the fanout set and
// never throws into the publisher or other subscribers. Payload is the IDENTICAL
// EventEnvelope JSON — `ws.send(JSON.stringify(envelope))` — no second contract
// (TRN-06), so switching TRANSPORT requires no call-site edit (GOV-REU-01).

import type { EventEnvelope } from "../event-envelope.js";

/** Minimal structural surface of a ws-like server-side socket. */
export interface WsSocketLike {
  /** Must deliver the raw JSON text frame to this client. */
  send(data: string): unknown;
  /** Terminate the socket for this client. */
  close(): unknown;
  /** Optional teardown hooks; the hub tolerates their absence (test doubles). */
  on?(event: "close" | "error", listener: () => void): unknown;
}

/** One connected WebSocket client (mirror of SseConnection). */
export interface WsConnection {
  readonly id: number;
  /** Send one envelope as a JSON text frame; resolves immediately after send. */
  write(envelope: EventEnvelope): Promise<void>;
  /** Terminate the socket for this client. */
  end(): void;
}

/** Fan-out hub owned by the WebSocket publisher adapter (§4.1). */
export class WebSocketHub {
  private nextId = 1;
  private readonly connections = new Set<WsConnection>();

  /** Register one accepted socket; returns the tracked connection. */
  attach(socket: WsSocketLike): WsConnection {
    const connection: WsConnection = {
      id: this.nextId++,
      // Identical payload to the SSE `data:` frame body (TRN-06).
      write: async (envelope: EventEnvelope) => {
        socket.send(JSON.stringify(envelope));
      },
      end: () => {
        try {
          socket.close();
        } catch {
          /* already gone */
        }
      },
    };
    this.connections.add(connection);
    // Guarded detach: a closed/broken socket leaves the fanout set only.
    socket.on?.("close", () => this.remove(connection));
    socket.on?.("error", () => this.remove(connection));
    return connection;
  }

  remove(connection: WsConnection): void {
    if (!this.connections.has(connection)) return;
    this.connections.delete(connection);
    connection.end();
    console.debug(`[ws] connection ${connection.id} removed`);
  }

  get size(): number {
    return this.connections.size;
  }

  /**
   * Fan out with allSettled-style isolation (TRN-RES-01): every send attempted,
   * failures remove only their own connection, no rejection escapes.
   */
  async fanout(envelope: EventEnvelope): Promise<void> {
    await Promise.allSettled(
      [...this.connections].map(async (connection) => {
        try {
          await connection.write(envelope);
        } catch {
          this.remove(connection);
        }
      }),
    );
  }

  async close(): Promise<void> {
    for (const connection of [...this.connections]) {
      this.remove(connection);
    }
  }
}
