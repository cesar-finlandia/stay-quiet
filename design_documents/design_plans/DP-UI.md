# DP-UI — The host-facing app: quiet monitor → decision ping → audit trail

## §0 Context & blockers

Must already exist:

* **DP-FOUND**: `src/index.ts` repaired; `npm install` done; Node 20+.
* **DP-API**: `src/stayquiet/api.py` serving `/api/state`, `/api/decisions/{id}`, `/api/audit`,
  `/api/runs`, `/events/stream`, `/events`; DP-API WU-02 passing.
* **DP-AGENT**: the `draft_reply` `done` envelope carries `payload.text`; the `clause_lookup`
  `done` envelope carries `payload.citations`.

Pre-existing and read-only: `src/platform/ui/` (three components, three themes, the token
stylesheet), `src/platform/transport/` (`useEventStream`, the `EventEnvelope` type).

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
11. `src/stayquiet/web/shims/node-fs.ts`

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
  `StreamingTextRenderer`, `CitationDisplay`) and no second copy of `useEventStream`.
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
import type { EventEnvelope } from "src/platform/transport";

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
  envelopes: EventEnvelope[];   // from useEventStream, or state.events as fallback
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

### 3.4 `src/stayquiet/web/shims/node-fs.ts` — complete file

```typescript
// Browser shim for `node:fs`.
// The pre-existing transport barrel statically imports readFileSync (it loads the
// envelope JSON Schema when the non-streaming fallback parses a snapshot). That path
// is never taken in this app — App.tsx passes fallback:"none" to useEventStream and
// polls /api/state instead — but the static import must still resolve for the
// browser bundle to build. This shim makes it resolve and makes a real call loud.
export function readFileSync(): never {
  throw new Error("readFileSync is not available in the browser (StayQuiet shim)");
}
export default { readFileSync };
```

## §4 Interfaces consumed

Copy verbatim.

```typescript
import type { EventEnvelope } from "src/platform/transport";                    // pre-existing platform/transport
import { useEventStream } from "src/platform/transport";                        // pre-existing platform/transport
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
// - `node:fs` is aliased to a browser shim: the pre-existing transport barrel
//   statically imports readFileSync for a code path this app never takes.
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
      "node:fs": `${root}src/stayquiet/web/shims/node-fs.ts`,
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

### §5.5 `App.tsx` algorithm

1. State: `const [state, setState] = useState<AppState>(EMPTY_STATE);` and
   `const [busyId, setBusyId] = useState<string | null>(null);`
2. Stream: `const stream = useEventStream({ fallback: "none" });`
   **`fallback: "none"` is required** — the built-in snapshot path parses against a JSON Schema it
   loads from disk, which is Node-only. The poll in step 3 covers the same ground in the browser.
3. Poll: a `useEffect` that calls `fetchState()` immediately and then every 3000 ms via
   `setInterval`, clearing the interval on unmount.
4. Envelopes to render: `const envelopes = stream.envelopes.length > 0 ? stream.envelopes :
   state.events;` — the live stream wins; the poll fills in when SSE is unavailable.
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
1. Create `src/stayquiet/web/shims/node-fs.ts` with §3.4 verbatim.
2. Replace `vite.config.ts` with §5.2 and `index.html` with §5.1.
3. Create `src/stayquiet/web/labels.ts` with §3.1 verbatim.
4. Create `src/stayquiet/web/api.ts` per §3.2 and §5.4.
5. Create `src/stayquiet/web/stayquiet.css` per §5.10 and `src/stayquiet/web/main.tsx` per §5.3.
6. Create the three components and `App.tsx` as **empty-state-only** renderers for now: the header,
   the synthetic banner, the quiet card, the three pre-existing components with `envelopes={[]}`,
   and the audit empty state. No fetching yet.

**Files created/modified.** all eleven files in §2 IN.

**Verification command.**
```bash
npm run build:ui 2>&1 | tail -5
```
**Expected output.** The last lines report a successful build, including a line naming
`dist/index.html` and at least one `dist/assets/*.js`, and end with `built in <n>s`. There must be
no line containing `error` or `Could not resolve`.

**What it proves.** The browser bundle compiles against the pre-existing UI and transport modules,
and the `node:fs` shim keeps the statically-imported Node built-in from breaking the build — the
single most likely build failure in this plan.

---

### WU-UI-02 — Live wiring

**Goal.** The real screen: stream, poll, decision cards, audit trail.

**Steps.**
1. Implement `App.tsx` per §5.5, including `useEventStream({ fallback: "none" })` and the
   3-second poll.
2. Implement `QuietMonitor.tsx` (§5.7), `DecisionPing.tsx` (§5.8) and `AuditTrail.tsx` (§5.9),
   using the §5.6 copy verbatim.
3. Confirm by grep that no `<input type="text">` and no chat field exists outside
   `DecisionPing.tsx`'s edit `<textarea>`.

**Files modified.** `App.tsx`, `QuietMonitor.tsx`, `DecisionPing.tsx`, `AuditTrail.tsx`.

**Verification command.**
```bash
npm run build:ui > /dev/null 2>&1 && grep -c "textarea" src/stayquiet/web/DecisionPing.tsx && grep -rl "useEventStream" src/stayquiet/web/ && grep -rc "type=\"text\"\|placeholder=\"Ask" src/stayquiet/web/*.tsx | grep -v ":0" | wc -l
```
**Expected output.**
```
1
src/stayquiet/web/App.tsx
0
```
**What it proves.** The build still passes with the live wiring, the edit textarea exists exactly
once, the stream hook is used in exactly one place, and there is no text input or "Ask…" field
anywhere — the no-chat-box rule holds mechanically, not just by intention.

> The middle line is the output of `grep -rl`; if `useEventStream` is imported in a second file,
> two paths print and the work unit fails.

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
npm run build:ui > /dev/null 2>&1 && grep -c "textarea" src/stayquiet/web/DecisionPing.tsx && grep -rl "useEventStream" src/stayquiet/web/ && grep -rc "type=\"text\"\|placeholder=\"Ask" src/stayquiet/web/*.tsx | grep -v ":0" | wc -l
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
| The browser build fails on the transport barrel's `node:fs` import | the shim plus the `node:fs` alias in `vite.config.ts`; WU-01's whole purpose is to catch this on day one |
| `useEventStream`'s built-in fallback runs in the browser and throws | `fallback: "none"` is required by §5.5 step 2, and the 3-second `/api/state` poll covers the same need |
| A judge sees a chat box and concludes it is another app to babysit | §2's first prohibition and WU-02's grep; the only input is the edit textarea |
| The UI drifts from the API shape | `AppState` in §3.2 mirrors DP-API §5.3 field for field, and `fetchState` spreads over `EMPTY_STATE` so a mismatch degrades instead of crashing |
| Hardcoded colours make the recording inconsistent with the slides | §5.10 requires the pre-existing token variables only; DP-SCRIPT reads the same tokens for its slide palette |
| The exposure figure reads as a real liability | the `Modelled exposure` label and the note beside it, in §5.6, on every card |
| Dev-proxy config differs between Vite versions | §5.2 says what to do if the option name is rejected: drop the key, since the target is same-machine |
