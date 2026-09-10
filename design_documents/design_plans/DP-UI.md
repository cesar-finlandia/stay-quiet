# DP-UI — The host-facing app: quiet monitor → decision ping → audit trail

## §0 Context & blockers

Must already exist:

* **DP-FOUND**: `src/index.ts` repaired; `npm install` done; Node 20+.
* **DP-API**: `src/stayquiet/api.py` serving `/api/state`, `/api/decisions/{id}`, `/api/audit`,
  `/api/runs`, `/events/stream`, `/events`; DP-API WU-02 passing.
* **DP-AGENT**: the `draft_reply` `done` envelope carries `payload.text`; the `clause_lookup`
  `done` envelope carries `payload.citations`.
* `contracts/event-envelope.schema.json` is at v1.1.0, so the underscore `step_id` vocabulary this
  plan filters and labels is contract-valid (see DP-STREAM §0).

Pre-existing and read-only: `src/platform/ui/` (three components, three themes, the token
stylesheet) and the generated type `src/platform/transport/event-envelope.ts`.

**Do not use `useEventStream` / `createSubscriber`.** They cannot run in a browser, for two
independent reasons, both verified against this repository:

1. **They do not bundle.** `useEventStream` is exported from the `src/platform/transport` barrel,
   which also re-exports `publisher.ts`, `subscriber.ts`, `fallback.ts` and `stream_router.ts`.
   Those four statically import `node:fs` (twice), `node:crypto` and `node:http`. Bundling a browser
   entry that imports `useEventStream` fails with four `Could not resolve "node:…"` errors. Aliasing
   one of them, as an earlier draft of this plan did, only moves the failure to the next one.
2. **Even bundled, they would drop every envelope.** `createSubscriber` validates each received
   envelope with the resilience layer's `validate()`, which loads `ajv` through `node:module`'s
   `createRequire`. Outside Node that resolver returns `null` and `validate()` raises
   `ajv validation requires a Node runtime (RES-04)` — from inside the `EventSource` message
   listener, which has no surrounding `try`. Every envelope would be lost, silently, in the one
   frame the demo video is built around.

So this plan owns its own short `EventSource` subscription (§3.4, §5.4a) and imports the envelope as
a **type only**. That keeps the whole browser graph free of Node builtins — verified: an entry
importing `src/platform/ui/*` plus `import type { EventEnvelope }` bundles in 13 ms with no external
node module. The three pre-existing UI components are still used exactly as they are; it is only the
transport *runtime* that a browser cannot load.

**Working directory for every command in this plan is the entry repository root.**

## §1 Purpose & requirement IDs

Own the one screen the host uses. Its default state is **quiet**: a monitor that shows the agent
working and nothing to answer. When there is something to answer, one card appears with approve and
edit. Below both is the audit trail.

Requirements (blueprint §1): **SQ-F-07** (one decision ping, approve or edit, resolved from the
UI), **SQ-F-09** (quiet monitor is the default state — no chat box, no prompt field anywhere),
**SQ-F-10** (the step-by-step stream is what the viewer watches), **SQ-N-03** (every screen states
that the data is synthetic), **SQ-N-05** (degraded states are visible, labelled and non-blocking).

## §2 Scope boundaries

### IN — the only files this plan creates or modifies

1. `index.html` (replace wholesale — it is currently the dev shell for the component library)
2. `vite.config.ts` (replace wholesale — adds the dev proxy, the build output and one shim alias)
3. `src/stayquiet/web/main.tsx`
4. `src/stayquiet/web/App.tsx`
5. `src/stayquiet/web/QuietMonitor.tsx`
6. `src/stayquiet/web/DecisionPing.tsx`
7. `src/stayquiet/web/AuditTrail.tsx`
8. `src/stayquiet/web/api.ts`
9. `src/stayquiet/web/labels.ts`
10. `src/stayquiet/web/stayquiet.css`
11. `src/stayquiet/web/css.d.ts` — `declare module "*.css"` (amendment 2026-09-10,
    see §5.10a).

### OUT — owned elsewhere; never create or edit here

| File | Owner |
|---|---|
| `src/platform/ui/**`, `src/platform/transport/**` | pre-existing — read-only |
| `src/stayquiet/api.py` and every route | DP-API |
| `engine/**` | DP-TOOLS / DP-AGENT |
| `README.md`, `docs/**` | DP-SUBMIT |
| `Dockerfile` | DP-DEPLOY |
| `examples/**` | pre-existing dev shell — leave it alone; it is git-ignored |

Hard prohibitions:

* **No prompt box, no chat input, no "ask the agent" field anywhere.** The product's claim is that
  the host does not talk to it. A text area exists in exactly one place: editing a drafted reply
  before approving it.
* **No business logic.** The UI never diffs, never triages, never computes an exposure figure. It
  renders what `/api/state` returns.
* **No re-implementation of the three pre-existing components** (`StepStatusIndicator`,
  `StreamingTextRenderer`, `CitationDisplay`). They are used as they are, from their concrete paths.
* **No runtime import from `src/platform/transport`, and no import of `src/index.ts`.** The envelope
  type comes from `src/platform/transport/event-envelope.js` via `import type`, which erases at
  compile time. Anything else from that directory pulls Node builtins into the bundle (§0).
* **No new npm dependency.** React, React DOM and Vite are already in `package.json`.

## §3 Interfaces owned

### 3.1 `src/stayquiet/web/labels.ts`

```typescript
// StayQuiet UI — display labels for the closed step_id vocabulary (blueprint row 33).
// Keys are exactly the twelve step ids in blueprint §2.3; adding a key here without
// adding the step id there is a bug.
export const STEP_LABELS: Record<string, string> = {
  cycle: "Background cycle",
  policy_fetch: "Reading the policy page",
  policy_diff: "Comparing it with last month",
  booking_scan: "Finding affected bookings",
  booking_lookup: "Reading the booking and its messages",
  clause_lookup: "Quoting the current policy text",
  checklist_baseline: "Checking what may still be required",
  draft_reply: "Drafting the reply",
  turnover_checklist: "Building the turnover checklist",
  triage: "Deciding whether to ask you",
  audit_write: "Writing the audit trail",
  decision_resolved: "Your decision recorded",
};

/** Human label for a decision kind. */
export const KIND_LABELS: Record<string, string> = {
  refund: "Refund decision",
  exception: "Policy exception",
  review_risk: "Review risk",
};
```

### 3.2 `src/stayquiet/web/api.ts`

```typescript
// StayQuiet UI — the only place the browser talks to the backend.
// Every function resolves, never throws: a failed fetch returns a safe empty shape
// so the interface degrades to its empty states instead of a blank page.
import type { EventEnvelope } from "src/platform/transport/event-envelope.js";

// Amendment 2026-09-10: this line used to name the transport barrel. §4 and §2
// require the generated module path instead; a barrel import — even type-only —
// contradicts the prohibition this plan mechanically checks in WU-UI-01.

export type Decision = {
  decision_id: string;
  run_id: string;
  trace_id: string;
  booking_id: string;
  guest_name: string;
  listing_name: string;
  kind: string;
  summary: string;
  clause_ids: string[];
  draft_text: string;
  checklist: string[];
  modelled_exposure_eur: number;
  status: string;
  created_at: string;
  resolved_at: string | null;
  final_text: string | null;
  degraded: boolean;
};

export type RunRecord = {
  run_id: string;
  trace_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  bookings_scanned: number;
  bookings_affected: number;
  changed_clauses: string[];
  decisions: string[];
  quiet_actions: number;
  degraded: boolean;
  elapsed_ms: number;
  tokens: number;
  summary: string;
};

export type AuditEntry = {
  entry_id: string;
  at: string;
  action: string;
  booking_id: string;
  detail: string;
  trace_id: string;
  degraded: boolean;
};

export type AppState = {
  synthetic: boolean;
  run: RunRecord | null;
  cycle_running: boolean;
  decisions: Decision[];
  audit: AuditEntry[];
  cost: {
    total_tokens: number;
    request_count: number;
    estimated_cost_usd: number | null;
    budget_tokens: number;
    utilization: number;
    warnings: string[];
  };
  events: EventEnvelope[];
  latest_sequence: number;
  config: {
    demo_mode: boolean;
    model_id: string;
    region: string;
    cycle_interval_s: number;
    track: string;
    stack: string;
  };
};

/** The empty state rendered before the first successful poll, and after a failed one. */
export const EMPTY_STATE: AppState;

/** GET /api/state. Never throws; returns EMPTY_STATE on any failure. */
export async function fetchState(): Promise<AppState>;

/** POST /api/decisions/{id} with {action:"approve"} or {action:"edit", text}. */
export async function resolveDecision(
  decisionId: string,
  action: "approve" | "edit",
  text?: string,
): Promise<Decision | null>;

/** POST /api/runs. Returns true when a cycle was started. */
export async function startRun(): Promise<boolean>;
```

### 3.3 Component props

```typescript
// src/stayquiet/web/QuietMonitor.tsx
export type QuietMonitorProps = {
  envelopes: EventEnvelope[];   // from subscribeEnvelopes(), or state.events as fallback
  state: AppState;
  streamStatus: string;         // "connecting" | "open" | "closed" | "error"
  onRunNow: () => void;
};
export function QuietMonitor(props: QuietMonitorProps): JSX.Element;

// src/stayquiet/web/DecisionPing.tsx
export type DecisionPingProps = {
  decisions: Decision[];
  onResolve: (id: string, action: "approve" | "edit", text?: string) => void;
  busyId: string | null;
};
export function DecisionPing(props: DecisionPingProps): JSX.Element;

// src/stayquiet/web/AuditTrail.tsx
export type AuditTrailProps = {
  entries: AuditEntry[];
};
export function AuditTrail(props: AuditTrailProps): JSX.Element;
```

### 3.4 `subscribeEnvelopes()` and `isEnvelope()` — this plan's own SSE subscription

Declared in `src/stayquiet/web/api.ts`, next to the fetch helpers.

```typescript
/**
 * Subscribe to GET /events/stream and deliver each envelope to `onEnvelope`.
 *
 * This exists because the pre-existing useEventStream / createSubscriber cannot run
 * in a browser (§0): their module graph statically imports node:fs, node:crypto and
 * node:http, and their per-envelope validation needs ajv through node:module. This is
 * the browser-native equivalent — EventSource, the same `event: envelope` frame name
 * the backend emits, and a small structural guard in place of JSON Schema validation.
 *
 * Returns an unsubscribe function. Never throws.
 */
export function subscribeEnvelopes(handlers: {
  onEnvelope: (env: EventEnvelope) => void;
  onStatus: (status: StreamStatus) => void;
}): () => void;

export type StreamStatus = "connecting" | "open" | "closed" | "error";

/** True when `value` carries the five required envelope fields with the right types. */
export function isEnvelope(value: unknown): value is EventEnvelope;
```

## §4 Interfaces consumed

Copy verbatim.

```typescript
import type { EventEnvelope } from "src/platform/transport/event-envelope.js";  // pre-existing generated TYPE ONLY — never a runtime import
import { StepStatusIndicator } from "src/platform/ui/StepStatusIndicator.js";   // pre-existing platform/ui
import { StreamingTextRenderer } from "src/platform/ui/StreamingTextRenderer.js"; // pre-existing platform/ui
import { CitationDisplay } from "src/platform/ui/CitationDisplay.js";           // pre-existing platform/ui
import { isDegradedEnvelope } from "src/platform/ui/isDegraded.js";             // pre-existing platform/ui
import { resolveTheme } from "src/platform/ui/theme.js";                        // pre-existing platform/ui
import "src/platform/ui/tokens.css";                                            // token contract — import FIRST
import "src/platform/ui/themes/operator.css";                                   // the theme StayQuiet ships
```

The three components take `envelopes: EventEnvelope[]` and optional copy props; `StepStatusIndicator`
also takes `labelMap`. Their exact prop types are in `src/platform/ui/*.tsx` — read them, do not
guess, and do not add props they do not have.

Note the envelope import path: `src/platform/transport/event-envelope.js`, the generated type
module, **not** the `src/platform/transport` barrel, and always with `import type` so it erases at
compile time. The three UI components import the type the same way, which is why they bundle for the
browser while the barrel does not (§0). There is no runtime import from that directory anywhere in
this plan.

Backend contract (owned by DP-API): `GET /api/state` returns the `AppState` shape of §3.2;
`POST /api/decisions/{id}` takes `{"action","text"}` and returns `{"decision": Decision}`;
`POST /api/runs` returns `{"started": boolean}`; `GET /events/stream` emits SSE frames named
`envelope`.

## §5 Literal files and algorithms

### §5.1 `index.html` — complete replacement file

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>StayQuiet — background agent for short-stay hosts</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/stayquiet/web/main.tsx"></script>
  </body>
</html>
```

### §5.2 `vite.config.ts` — complete replacement file

```typescript
// Vite config for the StayQuiet single-page app.
// - `src` and `examples` aliases match the TypeScript paths in tsconfig.json.
// - No node-builtin alias is needed or wanted: nothing this app imports at runtime
//   reaches src/platform/transport, so node:fs / node:crypto / node:http never enter
//   the graph. If a build ever reports "Could not resolve node:…", the cause is a new
//   runtime import from that directory — remove it rather than aliasing around it.
// - The dev server proxies the API and the event stream to the Python service on
//   8080, so `npm run dev` and the deployed container behave identically.
// - The build writes to dist/, which src/stayquiet/api.py serves.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const API = "http://127.0.0.1:8080";

export default defineConfig({
  resolve: {
    alias: {
      src: `${root}src`,
      examples: `${root}examples`,
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API, changeOrigin: true },
      "/events": { target: API, changeOrigin: true, ws: false },
      "/healthz": { target: API, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
```

`changeOrigin` is the option name the underlying proxy uses. If the installed Vite version
rejects it, delete that key from all three entries: the proxy still works for a same-machine
target, and this config only matters for `npm run dev`. The deployed container never uses the
proxy — the Python service serves the built bundle from the same origin.

### §5.3 `src/stayquiet/web/main.tsx` — complete file

```tsx
// StayQuiet — browser entry point. Theme first, then the app.
import { createRoot } from "react-dom/client";
import { resolveTheme } from "src/platform/ui/theme.js";
import { App } from "./App.js";

import "src/platform/ui/tokens.css";
import "src/platform/ui/themes/operator.css";
import "./stayquiet.css";

resolveTheme("operator");

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
```

### §5.4 `api.ts` algorithms

* `EMPTY_STATE`: every array `[]`, `run: null`, `cycle_running: false`, `synthetic: true`,
  `latest_sequence: 0`, `cost` all zeros with `estimated_cost_usd: null` and `warnings: []`,
  `config` with `demo_mode: false`, `model_id: ""`, `region: ""`, `cycle_interval_s: 0`,
  `track: "Professional Agents"`, `stack: "Strands Agents SDK for Python on Amazon Bedrock"`.
* `fetchState()`:
  1. `try { const r = await fetch("/api/state", { headers: { accept: "application/json" } }); if
     (!r.ok) return EMPTY_STATE; const j = await r.json(); return { ...EMPTY_STATE, ...j }; } catch
     { return EMPTY_STATE; }`
  2. The spread means a backend that adds a key later cannot break the UI, and a missing key falls
     back to its empty value.
* `resolveDecision(id, action, text)`:
  1. `POST` to `/api/decisions/${encodeURIComponent(id)}` with
     `JSON.stringify(action === "edit" ? { action, text } : { action })` and
     `headers: {"content-type": "application/json"}`.
  2. On a non-2xx or a throw, return `null`.
  3. Otherwise return `(await r.json()).decision as Decision`.
* `startRun()`: `POST /api/runs`; return `Boolean((await r.json()).started)`; on any failure return
  `false`.

### §5.4a `subscribeEnvelopes()` and `isEnvelope()` algorithms

`isEnvelope(value)` — a structural guard, not schema validation:

1. Return `false` unless `value` is a non-null object.
2. Return `true` only when all of these hold: `typeof v.step_id === "string"`,
   `typeof v.status === "string"`, `typeof v.sequence === "number"`,
   `typeof v.timestamp === "string"`, and `v.payload` is a non-null object.
3. Nothing else is checked. The backend already builds every envelope in one place and the
   repository's own `contracts/event-envelope.schema.json` check runs there (DP-STREAM WU-01), so a
   second full validation in the browser would buy nothing and cost the ajv dependency this plan
   cannot load.

`subscribeEnvelopes({ onEnvelope, onStatus })`:

1. `onStatus("connecting")`.
2. `const es = new EventSource("/events/stream");` inside `try`. If the constructor throws — no
   `EventSource` in this runtime — call `onStatus("error")` and return a no-op function.
3. `es.addEventListener("open", () => onStatus("open"));`
4. `es.addEventListener("envelope", (evt) => { … })` where the body is wrapped in
   `try/catch` and does: `JSON.parse((evt as MessageEvent).data)`, then
   `if (isEnvelope(parsed)) onEnvelope(parsed)`. A parse failure or a non-envelope is ignored
   silently — one malformed frame must never stop the stream.
   The event name is `envelope` because that is what the backend writes
   (`event: envelope`, DP-API §5.2). Do not use `es.onmessage`: named events do not reach it.
5. `es.onerror = () => onStatus(es.readyState === 2 ? "closed" : "connecting");` — the browser
   reconnects on its own, so there is no retry policy to write here.
6. Return `() => { try { es.close(); } catch { /* already closed */ } onStatus("closed"); }`.

Nothing in this function imports anything. It is about twenty-five lines and it replaces a
pre-existing hook that cannot run in a browser at all (§0) — that trade is the point.

### §5.5 `App.tsx` algorithm

1. State: `const [state, setState] = useState<AppState>(EMPTY_STATE);` and
   `const [busyId, setBusyId] = useState<string | null>(null);`
2. Stream: hold `const [envs, setEnvs] = useState<EventEnvelope[]>([])` and
   `const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting")`, then in a
   `useEffect` with an empty dependency array call `subscribeEnvelopes({ onEnvelope, onStatus })`
   and return its unsubscribe function as the effect's cleanup. `onEnvelope` inserts the envelope
   into `envs` keeping the array sorted by `sequence` and dropping a duplicate `sequence`.
   See §5.4a for `subscribeEnvelopes` itself.
3. Poll: a `useEffect` that calls `fetchState()` immediately and then every 3000 ms via
   `setInterval`, clearing the interval on unmount.
4. Envelopes to render: `const envelopes = envs.length > 0 ? envs : state.events;` — the live
   stream wins; the `/api/state` poll fills in when SSE is unavailable, which is this app's
   non-streaming fallback (SQ-F-10) and the reason no separate snapshot parser is needed.
5. `onResolve(id, action, text)`: set `busyId` to `id`, `await resolveDecision(...)`, then
   `setState(await fetchState())` and clear `busyId`.
6. `onRunNow()`: `await startRun()`, then refresh the state.
7. Render, in this order:
   * a header: the product name, the one-line description, the track, and a synthetic-data banner
     (see §5.6 for the exact strings);
   * `<DecisionPing …/>` **first when there is at least one pending decision**, otherwise
     `<QuietMonitor …/>` first. The order is the product's argument: when there is nothing to
     decide, the host sees quiet; when there is, the ask is at the top.
   * the other of the two;
   * `<AuditTrail entries={state.audit} />`;
   * a footer with the model id, the region, the cycle interval, the token total and the modelled
     cost.

### §5.6 Exact user-facing copy

Use these strings verbatim so the video's voiceover matches the screen.

| Where | String |
|---|---|
| Header title | `StayQuiet` |
| Header subtitle | `A background agent for independent short-stay hosts. It watches policy changes and your bookings, drafts what you would have written, and only asks when the decision is yours.` |
| Track badge | `Professional Agents · Strands Agents SDK for Python on Amazon Bedrock` |
| Synthetic banner | `Every booking, guest and policy page here is synthetic demo data. No real person's information appears in this app.` |
| Quiet state title | `Nothing needs you` |
| Quiet state body | `The agent is running in the background. It will ping you only for a refund, an exception, or a review risk.` |
| Monitor title | `What the agent is doing` |
| Monitor empty text | `Waiting for the next background cycle…` |
| Decision section title | `Needs your decision` |
| Approve button | `Approve and file` |
| Edit button | `Edit before filing` |
| Edit save button | `Save my wording` |
| Exposure label | `Modelled exposure` |
| Exposure note | `Modelled, not billed: a weighting of this booking's payout by decision type.` |
| Degraded badge | `Degraded — served from the recorded cache` |
| Audit title | `Audit trail` |
| Audit empty text | `Nothing logged yet.` |
| Run-now button | `Run a cycle now` |
| Footer cost note | `Estimated, not billed.` |

### §5.7 `QuietMonitor.tsx` algorithm

*Amendment 2026-09-10 — two additions to the algorithm below, both load-bearing:*

1. *`src/stayquiet/web/css.d.ts` (`declare module "*.css"`, §5.10a). `main.tsx` imports
   three stylesheets for their global side effects, which Vite resolves at build time
   but `tsc --noEmit` rejects with TS2882 per import. The pre-existing dev shell never
   hit this because `tsconfig.json` includes only `src/` while the shell lives in
   `examples/`. Without the declaration the repo's own type gate fails on every file
   this plan adds. One line, no runtime effect.*
2. *A "Latest draft" panel under the `StreamingTextRenderer`. The pre-existing renderer
   skips degraded envelopes for text (`if (isDegradedEnvelope(e)) continue`) and shows
   only its banner — correct for its chassis contract, but in StayQuiet's offline demo
   EVERY draft envelope is degraded, so the monitor would show an empty draft box through
   the whole video while the voiceover reads the reply. The panel renders the newest
   `draft_reply`/`done` envelope's `payload.text` with the §5.6 degraded badge beside it
   when that envelope is degraded. No read-only file is touched, no business logic is
   added (pure rendering of an envelope field DP-AGENT already emits for this purpose),
   and the specified `StreamingTextRenderer` usage — badge included — stays exactly as
   written. The use-case decides: the host must see what was drafted.*

1. Compute `pending = state.decisions.filter(d => d.status === "pending").length`.
2. If `pending === 0`, render the quiet card first: the quiet title and body from §5.6, plus the
   run summary from `state.run?.summary` when present.
3. Then render, in one column:
   * `<StepStatusIndicator envelopes={envelopes} labelMap={STEP_LABELS} title="What the agent is doing"
     emptyText="Waiting for the next background cycle…" showSequence={false} />`
   * `<StreamingTextRenderer envelopes={envelopes.filter(e => e.step_id === "draft_reply")}
     emptyText="No draft yet." degradedText="Degraded — served from the recorded cache" showCursor />`
   * `<CitationDisplay envelopes={envelopes} title="Policy text this was grounded in"
     emptyText="No policy clause read yet." />`
4. Render a small run strip when `state.run` exists: `bookings_affected` of `bookings_scanned`
   worked, `changed_clauses.length` policy changes, `quiet_actions` handled quietly,
   `elapsed_ms / 1000` seconds, and the words `live` or `recorded` from `state.config.demo_mode`.
5. Render the `Run a cycle now` button, wired to `onRunNow`. It is a convenience for a judge who
   does not want to wait for the interval — the label says "now", not "start", because cycles run
   without it.
6. Show a small dot for `streamStatus`: green for `open`, amber for `connecting`, grey for
   `closed`, red for `error`, with the status word as its `title` attribute.

### §5.8 `DecisionPing.tsx` algorithm

1. `const pending = decisions.filter(d => d.status === "pending");`
   `const resolved = decisions.filter(d => d.status !== "pending");`
2. If `pending.length === 0`, render nothing except a compact list of the most recent three
   resolved decisions (guest name, kind label, status, resolved time).
3. For each pending decision, render one card containing:
   * `KIND_LABELS[d.kind]` as the card's tag, plus `d.booking_id`, `d.guest_name`,
     `d.listing_name`;
   * `d.summary` as the headline sentence;
   * `Modelled exposure €{d.modelled_exposure_eur.toFixed(2)}` with the exposure note from §5.6;
   * the clause ids as small chips;
   * the drafted reply in a read-only block, and the checklist as a `<ul>` when non-empty;
   * a degraded badge when `d.degraded`;
   * two buttons: `Approve and file` → `onResolve(d.decision_id, "approve")`, and
     `Edit before filing` → reveal a `<textarea>` pre-filled with `d.draft_text` and a
     `Save my wording` button → `onResolve(d.decision_id, "edit", textareaValue)`.
4. Disable both buttons while `busyId === d.decision_id`.
5. The `<textarea>` in step 3 is the only free-text input in the whole app.

### §5.9 `AuditTrail.tsx` algorithm

1. If `entries.length === 0`, render the title and `Nothing logged yet.`
2. Otherwise render a definition list, newest first: the time (`at`, formatted as `HH:MM:SS`), the
   `action` in monospace, the `booking_id` when non-empty, and `detail`.
3. Rows with `degraded === true` get the degraded class.
4. Do not paginate and do not truncate `detail` — this is the dispute-defence view, and the video
   scrolls it.

### §5.10a `css.d.ts` — complete file

```typescript
// StayQuiet UI — ambient declarations for stylesheet side-effect imports.
declare module "*.css";
```

### §5.10 `stayquiet.css`

One stylesheet, using only the CSS custom properties already declared by
`src/platform/ui/tokens.css` and the operator theme — read that file and use its variable names; do
not invent colours or hardcode hex values. Required rules:

1. `.sq-shell` — max width 62rem, centred, 1.5rem padding, `gap: 1.5rem` column flex.
2. `.sq-header`, `.sq-badge`, `.sq-synthetic` — the banner is visually distinct but calm; the
   synthetic banner must be legible in a screen recording at 1080p, so no font smaller than 0.9rem.
3. `.sq-card` — the shared surface for the quiet card, each decision card and the audit panel.
4. `.sq-decision--pending` — a visible left border so the ask reads as the page's focus.
5. `.sq-degraded` — the degraded badge and row treatment.
6. `.sq-chip` — clause ids.
7. `.sq-dot--open|connecting|closed|error` — the stream indicator.
8. `.sq-footer` — small, muted.
9. A `@media (max-width: 40rem)` block that stacks the two columns.

## §6 Failure modes

| Failure | What degrades | What the user sees |
|---|---|---|
| `/api/state` unreachable | everything | the header, the synthetic banner and every empty state — never a blank page, because `fetchState` returns `EMPTY_STATE` |
| SSE unavailable | live step-by-step | `state.events` from the 3-second poll fills the same components; the stream dot goes grey |
| A resolve call fails | that one action | the button re-enables and the decision stays pending; the next poll shows the true state |
| A decision arrives with an unknown `kind` | that card's tag | `KIND_LABELS[kind]` is undefined, so render the raw kind — never crash on an unexpected value |
| An envelope has an unknown `step_id` | its label | `StepStatusIndicator` shows the raw id, which is exactly why the label map is a prop |
| A model turn degraded | wording quality | the degraded badge on the card and on the streamed draft, with the §5.6 string |

## §7 Work units

### WU-UI-01 — Shell, shim, config and the API client

**Goal.** A page that builds and shows the empty states with no backend running.

**Steps.**
1. Replace `vite.config.ts` with §5.2 and `index.html` with §5.1.
2. Create `src/stayquiet/web/labels.ts` with §3.1 verbatim.
3. Create `src/stayquiet/web/api.ts` per §3.2, §5.4 and §5.4a — including `subscribeEnvelopes` and
   `isEnvelope`.
5. Create `src/stayquiet/web/stayquiet.css` per §5.10 and `src/stayquiet/web/main.tsx` per §5.3.
6. Create the three components and `App.tsx` as **empty-state-only** renderers for now: the header,
   the synthetic banner, the quiet card, the three pre-existing components with `envelopes={[]}`,
   and the audit empty state. No fetching yet.

**Files created/modified.** all ten files in §2 IN.

**Verification command.**
```bash
npm run build:ui 2>&1 | tail -6; grep -rn "from \"src/platform/transport\"" src/stayquiet/web/ | grep -v "^.*import type" | wc -l
```
**Expected output.** The build's last lines report success — a line naming `dist/index.html`, at
least one `dist/assets/*.js`, and `built in <n>s` — with no line containing `error` or
`Could not resolve`. Then:
```
0
```
**What it proves.** The browser bundle compiles against the pre-existing UI components, and no file
imports the transport barrel at runtime. Those are the same fact: a single runtime import from that
barrel fails the build with four `Could not resolve "node:…"` errors, which is the most likely
failure in this plan (§0).

---

### WU-UI-02 — Live wiring

**Goal.** The real screen: stream, poll, decision cards, audit trail.

**Steps.**
1. Implement `App.tsx` per §5.5, including the `subscribeEnvelopes` effect and the 3-second poll.
2. Implement `QuietMonitor.tsx` (§5.7), `DecisionPing.tsx` (§5.8) and `AuditTrail.tsx` (§5.9),
   using the §5.6 copy verbatim.
 3. Confirm by grep that no `<input type="text">` and no chat field exists outside
    `DecisionPing.tsx`'s edit `<textarea>`.

*Amendment 2026-09-10 — citation list scope.* Step 3 of §5.7 passes the full envelope
list to `CitationDisplay`. That component renders its degraded banner when ANY
envelope in its list is degraded — including an unrelated degraded draft — so with
the specified wiring the citations panel showed a lone "none" badge in every demo
run (no `clause_lookup` envelope is ever degraded, and in demo mode none exists at
all). `QuietMonitor` therefore passes only envelopes whose payload carries a
non-empty `citations` or `sources` array; a genuinely degraded clause lookup that
still carries citations keeps its banner through the same rule, and the empty state
("No policy clause read yet.") is honest when nothing was read.

**Files modified.** `App.tsx`, `QuietMonitor.tsx`, `DecisionPing.tsx`, `AuditTrail.tsx`.

**Verification command.**
```bash
npm run build:ui > /dev/null 2>&1 && grep -c "textarea" src/stayquiet/web/DecisionPing.tsx && grep -rl "subscribeEnvelopes(" src/stayquiet/web/*.tsx && grep -rc "type=\"text\"\|placeholder=\"Ask" src/stayquiet/web/*.tsx | grep -v ":0" | wc -l
```
**Expected output.**
```
1
src/stayquiet/web/App.tsx
0
```
**What it proves.** The build still passes with the live wiring, the edit textarea exists exactly
once, the subscription is opened in exactly one component, and there is no text input or "Ask…"
field anywhere — the no-chat-box rule holds mechanically, not just by intention.

> The middle line is the output of `grep -rl`; if `subscribeEnvelopes(` is called from a second
> component, two paths print and the work unit fails. Opening two `EventSource` connections would
> double every envelope in the UI.

---

### WU-UI-03 — End to end against the running service

**Goal.** See the real thing work: a cycle streaming into the page, a decision approved from the UI.

**Steps.**
1. Terminal 1: `STAYQUIET_DEMO_MODE=1 STAYQUIET_CYCLE_INTERVAL_S=30 python -m src.stayquiet`
2. Terminal 2: `npm run build:ui`
3. Open `http://127.0.0.1:8080/` in a browser. Confirm by eye, and record in the run report:
   1. the header, the track badge and the synthetic banner are visible;
   2. within ~5 seconds of a cycle starting, the progress list fills with the labelled steps;
   3. three decision cards appear with the kinds `Policy exception`, `Refund decision`,
     `Review risk`, and the exposures `€306.00`, `€395.00`, `€263.00`;
   4. clicking `Approve and file` on one card resolves it and a `host_decision` row appears in the
     audit trail within one poll;
   5. clicking `Edit before filing` on another shows the textarea pre-filled with the draft;
   6. the degraded badge is visible on the drafts (demo mode).
4. Stop both processes.

**Files created/modified.** none.

**Verification command.**
```bash
STAYQUIET_DEMO_MODE=1 python - <<'EOF'
from fastapi.testclient import TestClient
from src.stayquiet.api import app
import pathlib
with TestClient(app) as c:
    html = c.get('/').text
    print('served-spa', '/assets/' in html and 'StayQuiet' in html)
    print('dist', pathlib.Path('dist/index.html').is_file())
EOF
```
**Expected output.**
```
served-spa True
dist True
```
**What it proves.** The built single-page app is what the Python service serves at `/`, so the
deployed container needs no second process and no separate static host — one port, one URL, which
is what the live-demo link has to be.

---

## §8 Verification summary

```bash
# WU-UI-01
npm run build:ui 2>&1 | tail -5
# WU-UI-02
npm run build:ui > /dev/null 2>&1 && grep -c "textarea" src/stayquiet/web/DecisionPing.tsx && grep -rl "subscribeEnvelopes(" src/stayquiet/web/*.tsx && grep -rc "type=\"text\"\|placeholder=\"Ask" src/stayquiet/web/*.tsx | grep -v ":0" | wc -l
# WU-UI-03
STAYQUIET_DEMO_MODE=1 python -c "
from fastapi.testclient import TestClient
from src.stayquiet.api import app
import pathlib
with TestClient(app) as c:
    html=c.get('/').text
    print('served-spa', '/assets/' in html and 'StayQuiet' in html)
    print('dist', pathlib.Path('dist/index.html').is_file())"
```

## §9 Risks

| Risk | Mitigation |
|---|---|
| The browser build fails on a Node builtin reached through the transport barrel | §0 explains the mechanism, §4 imports the envelope as a type only from the generated module, and WU-01's second check asserts zero runtime imports from that directory |
| An implementor "restores" `useEventStream` because the plan reuses everything else | §0 documents both failure modes with the exact error strings, and §2's prohibition names the rule; the twenty-five lines in §5.4a are the deliberate exception to reuse |
| No non-streaming fallback because the pre-existing snapshot parser is unused | the 3-second `/api/state` poll carries `events`, so the UI fills in with no SSE at all — asserted by DP-API WU-03 |
| A judge sees a chat box and concludes it is another app to babysit | §2's first prohibition and WU-02's grep; the only input is the edit textarea |
| The UI drifts from the API shape | `AppState` in §3.2 mirrors DP-API §5.3 field for field, and `fetchState` spreads over `EMPTY_STATE` so a mismatch degrades instead of crashing |
| Hardcoded colours make the recording inconsistent with the slides | §5.10 requires the pre-existing token variables only; DP-SCRIPT reads the same tokens for its slide palette |
| The exposure figure reads as a real liability | the `Modelled exposure` label and the note beside it, in §5.6, on every card |
| Dev-proxy config differs between Vite versions | §5.2 says what to do if the option name is rejected: drop the key, since the target is same-machine |
