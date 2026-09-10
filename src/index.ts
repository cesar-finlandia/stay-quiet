// Public TypeScript barrel for the parts of this repository the browser bundle uses.
// Only browser-safe surfaces are re-exported. The envelope arrives as a TYPE ONLY,
// from the generated module rather than the transport barrel: that barrel's runtime
// exports (publisher, subscriber, fallback, stream_router) statically import
// node:fs, node:crypto and node:http, and any runtime re-export drags all three
// into a browser bundle. Frontend code should still prefer the concrete path.
export type { DegradedResultRef, EventEnvelope } from "./platform/transport/event-envelope.js";
export * from "./platform/ui/index.js";
