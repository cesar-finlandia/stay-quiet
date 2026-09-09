// Requirement IDs: TRN-04, TRN-05, TRN-06, TRN-RES-02 | React hook (DP-B §4.2.2)
// Primary UI consume primitive. Accumulates envelopes in `sequence` order,
// flips degraded=true if any envelope had degraded===true (UI-RES-02), and owns
// the reconnect policy (TRN-RES-02): a reconnect starts a FRESH subscription.
import { useCallback, useEffect, useRef, useState } from "react";
import { createSubscriber } from "./subscriber.js";
import type { SubscribeOptions, Subscriber } from "./subscriber.js";
import { fetchEventFallback } from "./fallback.js";
import type { EventEnvelope } from "./event-envelope.js";

export type StreamStatus = "connecting" | "open" | "closed" | "error";

export interface UseEventStreamResult {
  envelopes: EventEnvelope[];
  status: StreamStatus;
  error: Error | null;
  degraded: boolean;
  /** Manual reconnect trigger (TRN-RES-02) — opens a fresh subscription. */
  reconnect: () => void;
}

/** Insert `env` keeping the array sorted by sequence (TRN-05 accumulation). */
function insertBySequence(list: EventEnvelope[], env: EventEnvelope): EventEnvelope[] {
  let i = list.length;
  while (i > 0 && (list[i - 1]?.sequence ?? 0) > env.sequence) i -= 1;
  if (i === list.length) return [...list, env]; // common case: in-order append
  return [...list.slice(0, i), env, ...list.slice(i)];
}

export function useEventStream(opts?: SubscribeOptions): UseEventStreamResult {
  const [envelopes, setEnvelopes] = useState<EventEnvelope[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [error, setError] = useState<Error | null>(null);
  const [degraded, setDegraded] = useState(false);

  // Callbacks live in a ref so identity churn never re-opens the stream.
  const optsRef = useRef<SubscribeOptions | undefined>(opts);
  optsRef.current = opts;

  const subscriberRef = useRef<Subscriber | null>(null);
  const reconnectsRef = useRef(0); // auto-reconnect budget: one per subscription
  const disposedRef = useRef(false); // unmount/close guard for async fallback

  // TRN-RES-03 client wiring (§4.6): after the ONE retry fails, fetch GET /events
  // once and populate envelopes ATOMICALLY — consumers cannot distinguish fallback
  // from streaming at the prop level (both see envelopes: EventEnvelope[]).
  const runFallbackFetch = useCallback(async () => {
    setStatus("connecting");
    try {
      const snapshot = await fetchEventFallback({
        url: optsRef.current?.url ? optsRef.current.url.replace(/\/stream$/, "") : undefined,
        traceId: optsRef.current?.traceId,
      });
      if (disposedRef.current) return;
      setError(null);
      if (snapshot.degraded || snapshot.events.some((env) => env.degraded === true)) setDegraded(true);
      setEnvelopes([...snapshot.events]); // already sequence-sorted in parseSnapshot
      setStatus("closed"); // complete snapshot delivered — stream intentionally ended
    } catch (err) {
      if (disposedRef.current) return;
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      setStatus("error");
      optsRef.current?.onError?.(e);
    }
  }, []);

  const openSubscription = useCallback(() => {
    disposedRef.current = false;
    subscriberRef.current?.close();
    setEnvelopes([]); // TRN-RES-02: fresh subscription — client resets its buffer
    setStatus("connecting");
    setError(null);
    subscriberRef.current = createSubscriber({
      ...(optsRef.current ?? {}),
      onEnvelope: (env) => {
        setStatus("open");
        if (env.degraded === true) setDegraded(true);
        optsRef.current?.onEnvelope?.(env);
        setEnvelopes((prev) => insertBySequence(prev, env));
      },
      onError: (e) => {
        setError(e);
        setStatus("error");
        optsRef.current?.onError?.(e);
        // Auto-reconnect ONCE per subscription when fallback:"auto" (default);
        // if that retry fails too, downgrade to the non-streaming fallback.
        const fallback = optsRef.current?.fallback ?? "auto";
        if (fallback === "auto" && reconnectsRef.current < 1) {
          reconnectsRef.current += 1;
          openSubscription();
        } else if (fallback === "auto") {
          void runFallbackFetch();
        }
      },
      onDegraded: (env) => {
        optsRef.current?.onDegraded?.(env);
      },
    });
  }, []);

  const url = opts?.url;
  const traceId = opts?.traceId;
  const transport = opts?.transport;
  const fallback = opts?.fallback;
  useEffect(() => {
    reconnectsRef.current = 0;
    openSubscription();
    return () => {
      disposedRef.current = true;
      subscriberRef.current?.close();
      subscriberRef.current = null;
      setStatus("closed");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, traceId, transport, fallback, openSubscription]);

  const reconnect = useCallback(() => {
    reconnectsRef.current = 0; // manual trigger resets the one-shot budget
    openSubscription();
  }, [openSubscription]);

  return { envelopes, status, error, degraded, reconnect };
}
export type { EventEnvelope, SubscribeOptions, Subscriber };
