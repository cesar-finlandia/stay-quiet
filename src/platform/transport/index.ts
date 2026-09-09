// Requirement IDs: TRN-06 (single source of truth; DP-B §3.5)
// Consumers MUST import the envelope via this re-export — never inline:
//   import type { EventEnvelope } from "src/platform/transport";
export type {
  DegradedResultRef,
  EventEnvelope,
} from "./event-envelope.js";
export { EnvelopeValidationError, createPublisher, resolveTransport } from "./publisher.js";
export type {
  CollectablePublisher,
  EnvelopeStatus,
  PublishOptions,
  Publisher,
  SsePublisher,
} from "./publisher.js";
export { buildFallbackUrl, fetchEventFallback, parseSnapshot, resolveApiBase } from "./fallback.js";
export type { FallbackSnapshot, FetchFallbackOptions } from "./fallback.js";
export { createSubscriber } from "./subscriber.js";
export type { SubscribeOptions, Subscriber } from "./subscriber.js";
export { useEventStream } from "./useEventStream.js";
export type { StreamStatus, UseEventStreamResult } from "./useEventStream.js";