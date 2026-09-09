#!/usr/bin/env bash
# run_sweep.sh - merged autonomous agent driver (Pi harness default, OpenCode fallback).
#
# Merges the former two-loop `run_agent.sh` (per-module sweep with context-window
# watchdog) and `run_sequential.sh` (module sequence) into ONE sequence-aware
# driver. `run_agent.sh` / `run_sequential.sh` remain as one-line exec shims.
#
# FOUR MODES (exactly one required):
#   --prompts FILE [--step N] [--role R] ...   single-module sweep (old run_agent.sh)
#   --sequence [FILE] [--from M] [--resumes N] ...  sequence sweep over run_sequential.conf
#   --planner [FILE] [--from M] [--force] ...  Step 2: design plans -> prompts JSON
#                                              (reads run_planner.conf, writes prompts,
#                                               rewrites run_sequential.conf)
#   --chat FILE [--conversation-id ID] [--role R] ...  headless chat (DP-CHAT): one
#                                              harness session per conversation, follow-up
#                                              turns continue the SAME session, history in
#                                              .chat/<id>/, overflow -> compaction.
#                                              Read-only utilities: --print-history /
#                                              --list-conversations (no mode flag needed).
#
# HARNESS:
#   HARNESS=pi|opencode (default pi, set via --harness or AAD_HARNESS).
#   Pi mode runs `pi --mode json --approve --session-dir <dir> --model <provider/id>`
#   and parses the on-disk session JSONL under $WORKDIR/.pi_sessions.
#   OpenCode mode keeps the original `opencode run --auto` behaviour as fallback.
#
# WATCHDOG (KILL_MODE):
#   budget (default, Pi mode): stop the agent when cumulative usage.input
#     (assistant messages + compaction.tokensBefore) crosses the resolved
#     threshold (--limit > role context_window_handout > KILL_PCT% of models.json
#     context_window > 150000). Then continue the SAME session to write the
#     progress handout, recycle to a fresh session, repeat. Apples-to-apples with
#     the old OpenCode numbers.
#   compact (opt-in --kill-mode compact, Pi only): let Pi's automatic compaction
#     manage context. No usage-based recycle; only an explicit --limit is a hard
#     economic ceiling. One session per step. Measures Pi's cache win.
#
# CRASH RESILIENCE (unchanged from run_agent.sh): run_state.json + handout*.md +
# --resume/--restore/--audit + per-step summaries + DP-SUPERVISOR protocol.
#
# Requirements:
#   - Pi reachable on PATH when HARNESS=pi (or PI_TEST_CMD stub override), or
#     `opencode` on PATH when HARNESS=opencode (Windows Git Bash uses `winpty`
#     when a TTY is present, see run_opencode()).
#   - python3 available (for JSON parsing).
#
set -uo pipefail

# Force UTF-8 for every python3 helper: on Windows the default console/stdin
# encoding is cp1252, which corrupts or crashes on non-ASCII (model names,
# session titles, agent-written handouts).
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

# ensure the opencode CLI is reachable even in non-login shells (opencode fallback)
if ! command -v opencode >/dev/null 2>&1; then
  for _d in "$HOME/.opencode/bin" "${LOCALAPPDATA:-}/opencode/bin"; do
    [ -x "$_d/opencode" ] && { PATH="$_d:$PATH"; break; }
  done
fi

MODEL_NAME="opencode/deepseek-v4-flash-free"
PROMPTS_FILE="prompts.json"
HANDOVER_FILE="handout.md"
STATE_FILE="run_state.json"
WORKDIR="$(pwd)"

# Driver log file (always written). Console writes must never stall the driver:
# Windows mintty Quick Edit / a frozen Git Bash window blocks stdout writes and
# can make --sequence look "hung" while the agent is actually running.
# (Ported from run_cursor_sweep.sh.)
DRIVER_LOG="${DRIVER_LOG:-$WORKDIR/_driver.log}"

# Sweep-state globals, initialized up front so EVERY mode has defined values:
# the INT/TERM/HUP -> graceful_shutdown -> save_state path runs even in planner
# mode, which never executes run_module_sweep (where these used to be set).
# Without this, a Ctrl+C during --planner died on "MODULE: unbound variable"
# under `set -u` before state could be persisted.
MODULE=""
TOTAL=0
CURRENT_STEP=0
COMPLETED_CSV=""
CURRENT_HANDOUT=""
STAGE="none"
STEP_AGENT_COUNT=0

# --- harness + watchdog (new, per DP-PI-HARNESS-MIGRATION §6.1) -------------
HARNESS="${AAD_HARNESS:-pi}"          # pi (default) | opencode
KILL_MODE="budget"                    # budget (default) | compact ; only meaningful in Pi mode
PI_SESSION_DIR="${PI_SESSION_DIR:-$WORKDIR/.pi_sessions}"
PI_CACHE_RETENTION="${PI_CACHE_RETENTION:-long}"
PI_TEST_CMD="${PI_TEST_CMD:-}"        # test override: if set, run_pi invokes this instead of `pi`
HARD_LIMIT=""                         # explicit --limit N (the only kill in compact mode)

# --- session history pruning (pi mode, on --session resumes) -----------------
# Old raw tool outputs and old reasoning scratchpads are dead weight: the agent
# reacts to a tool result once, durable knowledge goes to external books
# (FINDINGS.md / RUN-REPORT.md), and every later turn re-uploads the rest.
# Pruning replaces them with one-line stubs (.bak kept next to the file).
# Runs at resume boundaries only - each prune breaks the provider prefix cache
# once, which is why it is NOT done every turn. Measured on E2E-BROWSER-P1:
# 116.9k -> 60.2k live tokens (-48%). Disable with PI_PRUNE=0.
PI_PRUNE="${PI_PRUNE:-1}"
PI_PRUNE_TOOL_OVER_CHARS="${PI_PRUNE_TOOL_OVER_CHARS:-1024}"   # stub tool results larger than this
PI_PRUNE_KEEP_RESULTS="${PI_PRUNE_KEEP_RESULTS:-5}"            # never prune the newest N tool results
PI_PRUNE_KEEP_THINKING="${PI_PRUNE_KEEP_THINKING:-10}"         # keep reasoning in newest N assistant steps
PI_PRUNE_MIN_FILE_KB="${PI_PRUNE_MIN_FILE_KB:-200}"            # skip sessions smaller than this

# --- context injection -------------------------------------------------------
# When set, this file's contents are prepended to every driver-sent prompt
# (chat turns, continue-nudges), so the agent always carries the durable-state
# digest in-window even after pruning removed the raw material it came from.
# Capped well under the ~32 KB Windows argv limit.
CHAT_INJECT_FILE="${CHAT_INJECT_FILE:-}"
CHAT_INJECT_MAX_CHARS="${CHAT_INJECT_MAX_CHARS:-24576}"

# --- mid-flight user message ("flight prompt") ------------------------------
# Drop $WORKDIR/.prompt_flight.md while an agent turn is RUNNING and the driver
# delivers its contents INTO the live session at the next poll tick: SIGINT
# soft-stop (same mechanism as .control/INTERRUPT - completed work persists
# in-session, only the in-flight generation is cut) then same-session continue
# with the message. Atomic consume-by-rename (*.consumed-<ts> kept as audit).
# Freshness guard: files older than CHAT_FLIGHT_MAX_AGE_S are IGNORED (not
# deleted), so a stale drop from a previous session can never leak into a later
# run - delete or re-save it. Pi harness only.
CHAT_FLIGHT_FILE="${CHAT_FLIGHT_FILE:-$WORKDIR/.prompt_flight.md}"
CHAT_FLIGHT_MAX_AGE_S="${CHAT_FLIGHT_MAX_AGE_S:-600}"

# --- debug mode -------------------------------------------------------------
# Debug diagnostics are written ONLY to $DEBUG_FILE (never to stdout), so a
# failing run can be reproduced and analysed later (or handed to another agent)
# without polluting the terminal or .sequential_run.log. Enable with --debug or
# AAD_DEBUG=1. At every failure point the driver dumps a diagnostic bundle: the
# exact run configuration, the current session's transcript summary, every tool
# call still in flight (the "which command did not reply" answer), the tail of
# _run.log / _handout.log and the process list.
DEBUG="${AAD_DEBUG:-0}"               # 1 = debug enabled (--debug or env)
DEBUG_FILE="${DEBUG_FILE:-.debug_run.log}"

# --- IPC sentinel control plane (design_documents/draft_debugging_and_steering.md) --
# Dynamic steering via directory polling. Dropping a sentinel into $CONTROL_DIR
# steers a running driver WITHOUT restarting it:
#   .control/DEBUG      -> set DEBUG=1 on the fly (starts streaming to .debug_run.log)
#   .control/REPORT     -> full debug state dump + write status_report.md at the next yield
#   .control/INSTRUCT   -> inject .intramessages/instructions.md into the live handover context
#   .control/PAUSE      -> freeze the driver loop (the agent keeps running) until the file is removed
#   .control/INTERRUPT  -> SIGINT the stuck agent sub-process (soft interrupt, then escalate)
CONTROL_DIR="${CONTROL_DIR:-.control}"
MSG_DIR="${MSG_DIR:-.intramessages}"
STATUS_REPORT_FILE="${STATUS_REPORT_FILE:-status_report.md}"
mkdir -p "$CONTROL_DIR" "$MSG_DIR" 2>/dev/null || true

# sequence mode (from run_sequential.sh, defaulted not hardcoded)
SEQUENCE_MODE=false                   # true when --sequence was passed
PROMPTS_GIVEN=false                   # true when --prompts was passed
PLANNER_MODE=false                    # true when --planner was passed (Step 2)
PLANNER_CONF="${PLANNER_CONF:-run_planner.conf}"
PLANNER_OUT_DIR=""                    # --out-dir DIR (default prompts land under .run_sweep)
PLANNER_DRY_RUN=false                 # --dry-run: validate + print, spawn no agents
PLANNER_ROLE_NAME="planner"           # models.json role used for planning agents
PLANNER_RESULTS_FILE=".planner_results.txt"
PLANNER_LOG_FILE=".planner_run.log"
PLANNER=()                            # populated from $PLANNER_CONF (see load_planner_conf)
SEQUENCE_CONF="${SEQUENCE_CONF:-run_sequential.conf}"
LOG_FILE=".sequential_run.log"
RESULTS_FILE=".sequential_results.txt"
FROM=""                               # --from MODULE (sequence mode only)
FROM_GIVEN=false
FORCE=false                           # --force (sequence mode only; also skips locks)
MAX_RESUMES=4                         # --resumes N (sequence mode only)
RESUMES_GIVEN=false
BACKOFF_S=300                         # --backoff S (sequence mode only)
BACKOFF_GIVEN=false
SEQUENCE=()                           # populated from $SEQUENCE_CONF at startup (see load_sequence_conf)
GIT_INIT_ADD_PER_MODULE=false         # --git-init-add-per-module: git init if needed, then git add/commit per module

# --- sequencemd mode (--sequencemd): a conf of raw .md prompt files executed
# verbatim, one agent per file, top-to-bottom (e.g. design-plan authoring).
# After the sweep it (re)writes $PLANNER_CONF from $SEQMD_PLANS_DIR so the next
# step (`--planner`) can run without a hand-written conf.
SEQMD_MODE=false                      # true when --sequencemd was passed
SEQMD_CONF="${SEQMD_CONF:-run_sequential_md.conf}"
SEQMD_PROMPTS_OUT=".run_sweep/prompts_SEQMD.json"
SEQMD_PLANS_DIR="${SEQMD_PLANS_DIR:-design_documents/design_plans}"
CURRENT_MODULE=""                     # module currently being swept (for sup_relaunch_args)
GLOBAL_ROLE=""                        # --role as given on the command line
GLOBAL_KILL_MODE=""                   # --kill-mode as given on the command line
INTERRUPTED=false
GRACEFUL_SHUTDOWN_DONE=false          # set by graceful_shutdown for in-process propagation

# --- chat mode globals (DP-CHAT headless chat) -------------------------------
# One harness session per conversation: the session IS the conversation memory.
# The driver keeps only a lightweight index (.chat/<id>/) and re-dispatches
# follow-ups with run_agent_cli --session <sid>. Overflow -> compaction
# (summary + verbatim tail seeded into a fresh session), never handout recycling.
CHAT_MODE=false                       # true when --chat/--prompt was passed
CHAT_FILE=""                          # the user-turn markdown file (verbatim contents)
CHAT_SPELLING=""                      # "chat" | "prompt" (giving both aliases -> error)
CONVERSATION_ID=""                    # --conversation-id; default chat-YYYYMMDD-HHMMSS
CHAT_TITLE=""                         # --title TEXT (label stored in meta.json)
CHAT_NEW=false                        # --new: forbid attaching to an existing conversation
COMPACT_NOW=false                     # --compact-now: force compaction before this turn
PRINT_HISTORY=false                   # --print-history (read-only utility, no lock)
LIST_CONVERSATIONS=false              # --list-conversations (read-only utility, no lock)
CLEAN_GIVEN=false                     # --clean seen on argv (rejected in chat mode)
CHAT_DIR=""                           # .chat/<conversation_id> (runtime)
CHAT_RECORDS_FILE=".chat/turn_records.txt"   # shared conv|turn|status|elapsed|tokens_in|cache%|sid
CHAT_TURN=1                           # current turn number (completed turns + 1)
CHAT_USER_TEXT=""                     # byte-normalized user turn text
CHAT_PREAMBLE=""                      # fixed turn-1 preamble (cache-stable)
CHAT_PREAMBLE_SHA=""
CHAT_SEED_TAIL_TURNS="${CHAT_SEED_TAIL_TURNS:-2}"  # K verbatim pairs in a rebuild/compaction seed
CHAT_ACTIVE=false                     # true while a turn is in flight -> graceful_shutdown routes to chat
META_ROLE="" META_MODEL="" META_EFFORT="" META_HARNESS=""
META_KILL_AT="" META_TURNS=0 META_STATUS="" META_ACTIVE_SID="" META_CREATED_AT=""
SID=""                                # active harness session id (chat poll loop)
RUN_PID=""                            # agent process pid (chat poll loop)
WRITER_PID=""                         # summary-writer pid during compaction
CHAT_SNAP_BEFORE="0|0|0|0"            # usage snapshot "in|cr|cw|hit" before dispatch
CHAT_SNAP_AFTER="0|0|0|0"
CHAT_USED_AT_CROSS="0"
CHAT_PENDING_COMPACTION=""            # old sid awaiting the compaction event record
CHAT_COMPACTIONS_THIS_TURN=0
TURN_DISPATCH_S=0
CHAT_TURN_START_TS=""
CHAT_POLL_STATUS=""                   # ok | err | crossed | stalled
CHAT_LAST_ERR=""
# Same-session nudge for transient provider stream drops (chat wording).
CHAT_CONTINUE_PROMPT='Your previous message stream was cut off before your answer finished (provider stream drop). Do NOT restart the conversation and do NOT repeat earlier content: CONTINUE your previous answer exactly where it stopped and finish it.'

# --- supervisor (DP-SUPERVISOR) --------------------------------------------
SUPERVISE=false                      # --supervise: enable the autonomous supervisor
SUPERVISOR_DIR="${SUPERVISOR_DIR:-.supervisor}"
SUPERVISOR_LOG="${SUPERVISOR_LOG:-supervisor.log}"
SUPERVISOR_SOUND="${SUPERVISOR_SOUND:-G4 C5 E5}"        # melody spec or .wav path
SUPERVISOR_MAX_SOUNDS="${SUPERVISOR_MAX_SOUNDS:-2}"      # melody plays this many times per incident (0 = repeat forever)
SUPERVISOR_MENU_TIMEOUT_S="${SUPERVISOR_MENU_TIMEOUT_S:-120}"   # seconds before the supervisor auto-applies its recommended option (0 = wait forever)
SUPERVISOR_REPEAT_S="${SUPERVISOR_REPEAT_S:-30}"        # re-sound while the menu waits
SUPERVISOR_MAX_FIXERS="${SUPERVISOR_MAX_FIXERS:-2}"     # fixer attempts per incident
SUPERVISOR_MODE="${SUPERVISOR_MODE:-prompt}"            # prompt (menu) | auto
SUPERVISOR_MODEL="${SUPERVISOR_MODEL:-}"                # model id for supervisor/fixers
SUPERVISOR_CMD="${SUPERVISOR_CMD:-}"                    # override the supervisor invocation (testing)
SUPERVISOR_FIXER_CMD="${SUPERVISOR_FIXER_CMD:-}"        # override fixer invocation (testing)
# The Layer-2 supervisor runs as a SEPARATE process (scripts/supervise.sh), so
# every knob it reads must be exported or the child silently falls back to its
# own defaults (e.g. SUPERVISOR_MENU_TIMEOUT_S=0 -> it waits forever, which
# blocked the run at 04:39:47 with no prompt while the user slept).
export SUPERVISOR_DIR SUPERVISOR_LOG SUPERVISOR_SOUND SUPERVISOR_MAX_SOUNDS \
       SUPERVISOR_MENU_TIMEOUT_S SUPERVISOR_REPEAT_S SUPERVISOR_MAX_FIXERS \
       SUPERVISOR_MODE SUPERVISOR_MODEL SUPERVISOR_CMD SUPERVISOR_FIXER_CMD
PAUSED=false                       # SIGUSR1 -> pause at the next safe point
SUPERVISOR_RESUME=false            # SIGUSR2 -> continue
SUPERVISOR_RESET=false             # SIGHUP  -> save state, exit for relaunch
SUPERVISOR_ATTEND=false            # step-level shutdown is eligible for the supervisor
INCIDENT_N=0                       # incident counter (monotonic across resets)

# Per-step + whole-run reporting.
SUMMARY_DIR=".run_summaries"        # per-step summary files land here
SID_LIST_FILE=".step_sids.tmp"          # session ids seen in the current step
STEP_RECORDS_FILE=".run_step_records.txt" # step|status|elapsed|agents|tokens|cache% (for the final summary)
RUN_START_S=""                       # epoch of the whole run (set in run_module_sweep)
STEP_START_S=""                      # epoch of the current step (set before inner_loop)

# Auto-adaptive watchdog: by default the agent is stopped when its REAL context
# window (queried at startup from models.json in Pi mode / `opencode models`
# in OpenCode mode) is KILL_PCT% full. The last 100-KILL_PCT % of the window
# stays unused so the near-full session can still write the progress handout.
KILL_PCT=90               # kill + handout when the window is this % full (was 85)
FALLBACK_KILL_AT=150000   # used only if the window cannot be detected
KILL_AT=""                # empty = auto (KILL_PCT% of detected window); --limit N sets it
ROLE=""                   # --role NAME: resolved from models.json
ROLE_FILE="models.json"   # role -> model_profile -> provider/model + context_window_handout
EFFORT=""                 # reasoning effort from model_profiles.<name>.effort (--variant/--thinking value)
LIMIT_ARG=""              # explicit --limit N (overrides a role's handout threshold)
WINDOW_TOTAL=""
TIER30=0
TIER70=0
POLL_EVERY_S=10           # mid-tier poll interval; low tier = *3, top tier = /3
POLL_GIVEN=false          # true when --poll was passed on the command line
POLL_TIERS_SPEC=""        # per-model_profile absolute poll tiers ([[until_tokens,poll_s],...]) - overrides the % tiers
STOP_SLEEP_S=5            # grace after a force-kill before starting another opencode
HANDOVER_TIMEOUT_S=90     # hard deadline for the progress-handout writer
STALL_TIMEOUT_S=900       # agent alive but no progress (usage+log frozen) this long => model stall (quota/queue/blocked)
TOOL_STALL_TIMEOUT_S="${TOOL_STALL_TIMEOUT_S:-3600}"  # ceiling for a SINGLE in-flight tool call before it is declared hung (pi writes nothing to the session/log while a tool runs, so a long local command must not trip the stall watchdog; the agent's own test runs are capped at 1800s)
TOOL_LOG_S="${TOOL_LOG_S:-60}"       # design doc §3: log an in-flight tool's exact command to .debug_run.log after this many seconds
TOOL_DIAG_S="${TOOL_DIAG_S:-600}"    # design doc §3: also append the process-tree snapshot after this many seconds in-flight
MODEL_FAILURE_BACKOFF_S=60  # wait before retrying a step after a model/API failure (e.g. HTTP 503 queue-full)
MAX_MODEL_FAILURES=10       # consecutive failed sessions before giving up to --resume
# Premature-stop handling ("continue" nudge): some models end their turn early -
# clean exit, no transcript error, some work done - while the step is clearly
# unfinished (handout_active.md still on disk); transient provider stream drops
# ("Stream ended without finish_reason") cut other turns short mid-generation.
# Remedy, mirroring what a human types interactively: re-invoke the SAME session
# with a short continue prompt. Budget is a ROLLING RATE: at most
# MAX_CONTINUE_NUDGES sends within any CONTINUE_NUDGE_WINDOW_S seconds, plus an
# absolute CONTINUE_MAX_TOTAL cap per context window (guards a wedged session
# that drops streams forever).
# DELIBERATE-STOP exception (2026-08-25 CTAB-02): a clean exit that arrives
# together with an UPDATED handout_active.md is a finishing agent, not a cut-off
# (the STATE HANDOVER protocol makes the handout its last edit). Nudging it is
# what let one completed step-1 audit run off into every later module step.
# Those get ONE audit re-dispatch instead - see inner_loop.
MAX_CONTINUE_NUDGES="${MAX_CONTINUE_NUDGES:-3}"
CONTINUE_NUDGE_WINDOW_S="${CONTINUE_NUDGE_WINDOW_S:-60}"
CONTINUE_MAX_TOTAL="${CONTINUE_MAX_TOTAL:-40}"
# Outage-tolerant wedge detection: a network outage re-fails every nudge at the
# SAME token count within seconds, which a naive two-strike rule misreads as a
# poisoned session. Only declare wedged after WEDGE_MAX_CONSECUTIVE consecutive
# zero-progress errors, sleeping WEDGE_BACKOFF_SCHEDULE (Nth entry before the
# Nth retry; default 2s/30s/60s/120s ~= 3.5 min of outage tolerance) between
# them. Default: retries after the 1st-4th consecutive zero-progress error wait
# 2s/30s/60s/120s (~3.5 min of outage absorbed) before the 5th declares wedged.
WEDGE_MAX_CONSECUTIVE="${WEDGE_MAX_CONSECUTIVE:-5}"
WEDGE_BACKOFF_SCHEDULE="${WEDGE_BACKOFF_SCHEDULE:-2 30 60 120}"
SESSION_DISCOVERY_TIMEOUT_S=90  # hard wall-clock budget for session-id discovery after spawning an agent
START_STEP=1                          # 1-based, used for --step on a fresh run
STEP_GIVEN=false                      # true when --step was passed (prompts-only)
MODE="build"                          # build | audit  (sweep type)
RESUME=false                          # continue from run_state.json
RESTORE=false                         # force restore pass on current step

FRESH_PROMPT='You are an autonomous agent. First check whether a file named {HANDOVER} exists in the repo. If it does, read it, delete it, and continue with the remaining tasks it lists. Otherwise continue the repository work autonomously described by AGENTS.md / any design docs.
SCOPE DISCIPLINE: implement ONLY the work unit described in {HANDOVER}. Do NOT implement work belonging to LATER steps of the same module - each later step is dispatched separately and will do its own work.
IMPORTANT - if some of the work described in {HANDOVER} already exists in the repository: do NOT simply report it as already done. Earlier agents may have implemented ahead of their own step. Treat existing work as UNVERIFIED: check every requirement in {HANDOVER} against the actual code, RUN the verification commands named in {HANDOVER} yourself inside this session, FIX anything missing or wrong, and only finish once those verifications pass in YOUR session.'
RESTORE_PROMPT='You are RESUMING interrupted work. Read {HANDOVER} carefully. NOTE: some of the work described in that file may ALREADY have been implemented before the previous run was stopped. AUDIT the existing implementation first: verify what already exists in the repository correctly matches the specifications in {HANDOVER}, fix any incomplete or incorrect pieces, and only then implement whatever is still missing. Do not blindly re-run already-finished work. SCOPE DISCIPLINE: implement ONLY the work unit of the CURRENT step described in {HANDOVER}; do NOT start work belonging to LATER steps - each later step is dispatched separately and will do its own work. FINISH: when every requirement of the CURRENT step is implemented AND verified (tests/commands run in your session), delete {HANDOVER} and end your turn.'
AUDIT_PROMPT='You are AUDITING and COMPLETING a module that was implemented by an earlier run which may be incomplete, wrong, or untested. Read {HANDOVER}; it is the authoritative specification for this step. Do NOT trust the existing code: (1) verify that what exists actually satisfies EVERY requirement of THIS step in {HANDOVER}, (2) implement whatever is missing or unfinished, (3) fix anything that is incorrect, buggy, or does not follow the specification, and (4) run the relevant test suite - if tests fail or hang, find the root cause and fix it rather than working around it. Keep going until every requirement of THIS step is implemented correctly AND the relevant tests pass. Only then consider this step complete. SCOPE DISCIPLINE: implement ONLY the work unit of the CURRENT step described in {HANDOVER}; do NOT start work belonging to LATER steps - each later step is dispatched separately and will do its own work. Do not rewrite correct, working code without reason, but do not skip required work either. FINISH: when every requirement of the CURRENT step is implemented AND verified (tests/commands run in your session), delete {HANDOVER} and end your turn.'
# Sent to the SAME session when the model ended its turn early while the work
# unit is still unfinished (the "premature stop" failure mode; handout unchanged
# since dispatch - an UPDATED handout routes to the deliberate-stop audit
# instead, see inner_loop). Deliberately short: the session already holds the
# full plan/context; it only needs a resume signal plus an unambiguous,
# step-scoped finish criterion (2026-08-25 CTAB-02: an unscoped version made
# one nudge implement every remaining module step in a single turn).
CONTINUE_PROMPT='Your previous turn was cut off before the task was finished. Do NOT restart from scratch and do NOT restate your plan: CONTINUE exactly where you stopped. SCOPE DISCIPLINE: complete ONLY the remaining work of the CURRENT step described in handout_active.md - do NOT implement work belonging to LATER steps of the module; each later step is dispatched separately and will do its own work. When every requirement of the CURRENT step in handout_active.md is implemented AND verified (tests/commands run), delete handout_active.md and end your turn.'

# Best-effort console line. Must not block the watchdog: a frozen terminal
# (mintty Quick Edit) would otherwise hang the whole driver on a plain echo.
emit_console() {
  local line="$1"
  if [ -x /usr/bin/printf ]; then
    /usr/bin/printf '%s\n' "$line" >&2 &
  else
    printf '%s\n' "$line" >&2 &
  fi
  disown $! 2>/dev/null || true
}

log() {
  local _m="[$(date '+%H:%M:%S')] $*"
  printf '%s\n' "$_m" >>"$DRIVER_LOG" 2>/dev/null || true
  # Sequence mode runs every module in-process, so there is no run_agent.sh
  # subprocess whose output the old run_sequential.sh could `tee -a` into
  # $LOG_FILE. Mirror driver progress (poll/usage/spawn/kill/handout lines) into
  # .sequential_run.log there too, or `tail -f .sequential_run.log` stays silent
  # for the whole step and a healthy run looks dead.
  if [ "$SEQUENCE_MODE" = true ]; then printf '%s\n' "$_m" >>"$LOG_FILE" 2>/dev/null || true; fi
  # Console goes to stderr so command substitutions (prompt="$(fn)") cannot
  # capture ERROR/log lines and hand them to an agent as the "prompt".
  emit_console "$_m"
}
die()  { log "ERROR: $*"; dbg "die: $*"; exit 1; }

# --- debug logging ----------------------------------------------------------
# dbg writes ONLY to $DEBUG_FILE, never to stdout, so the terminal and the
# sequence log stay exactly as they are today. Each line is timestamped with
# full date/time (not just HH:MM:SS, so the file stays unambiguous across
# days / multiple runs). dbg_pipe mirrors stdin into the debug file line by
# line (used to capture file tails / transcripts / process lists).
dbg() {
  [ "$DEBUG" = "1" ] || return 0
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$DEBUG_FILE"
}

dbg_pipe() {
  [ "$DEBUG" = "1" ] || return 0
  local _line
  while IFS= read -r _line; do
    printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$_line" >>"$DEBUG_FILE"
  done
}

# Blank-line separator + banner marker in the debug file (keeps runs readable
# when several drivers share one DEBUG_FILE across days).
dbg_sep() {
  [ "$DEBUG" = "1" ] || return 0
  printf '[%s] ===== %s =====\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$DEBUG_FILE"
}

# --- platform detection -----------------------------------------------------
# The driver is written for Windows Git Bash (msys/cygwin), where `ps -W`,
# `tasklist`, `taskkill //F //T //PID` and `winpty` are the primitives that
# make process-tree killing and cross-terminal liveness work. When those are
# NOT present (Linux/WSL/CI shells), the helpers below fall back to POSIX
# equivalents (kill -0, pgrep -P recursive tree kill) so the driver remains
# testable there; on Git Bash the Windows path is used unchanged.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) PLATFORM_WIN=1 ;;
  *) PLATFORM_WIN=0 ;;
esac

# --- single-driver lock ----------------------------------------------------
# On Windows Git Bash `pgrep` is usually missing, so any guard built on it
# silently passes and a second driver can start and clobber the first (state
# file, handouts, _run.log, per-step summaries, per-step records). Replace it
# with an atomic `mkdir`-based lock that stores the holder's WINDOWS PID.
#
# Why the WINDOWS pid, not the msys pid: `ps -p <msys-pid>` from a DIFFERENT
# terminal/session does not see the holder (msys `ps` is session-scoped), so a
# second driver launched from another Git Bash window would wrongly treat the
# lock as stale and proceed. The Windows PID is global, and `tasklist //FI
# "PID eq N"` (a native Windows tool, always present in Git Bash) answers the
# liveness question reliably across every terminal.
#
# The merged driver holds ONE lock (.run_sweep.lock) for the whole run in both
# modes. Legacy locks (.run_agent.lock / .run_sequential.lock) are honoured so
# an old driver can never run concurrently with this one.
LOCK_DIR=".run_sweep.lock"

self_winpid() {                      # our own Windows PID via `ps -W` (POSIX: $$), "" on error
  if [ "$PLATFORM_WIN" = 1 ]; then
    ps -W 2>/dev/null | awk -v p="$$" 'NR>1 && $1==p {print $4}'
  else
    echo "$$"
  fi
}

pid_alive() {                        # $1 = PID -> 0 if the process is alive
  [ -n "$1" ] || return 1
  if [ "$PLATFORM_WIN" = 1 ]; then
    tasklist //FI "PID eq $1" 2>/dev/null | grep -qi "$1"
  else
    kill -0 "$1" 2>/dev/null
  fi
}

lock_held_by_live_pid() {            # $1 = lock dir -> 0 if held by a live process
  [ -d "$1" ] || return 1
  local holder
  holder="$(cat "$1/winpid" 2>/dev/null)"
  [ -n "$holder" ] && pid_alive "$holder"
}

acquire_lock() {                     # $1 = lock dir  $2 = who (for messages)
  local who="$2" winpid
  if [ "$FORCE" = true ]; then
    log "!! --force given: skipping the single-driver lock guard (NOT recommended)"
    return 0
  fi
  if lock_held_by_live_pid "$1"; then
    die "another $who driver (pid $(cat "$1/winpid" 2>/dev/null)) is already running in this repo. Refusing to start a second one - concurrent drivers corrupt run_state.json, handouts and _run.log. If it is truly gone, remove the stale lock first: rm -rf '$1'"
  fi
  if [ -d "$1" ]; then
    log "removing stale $who lock '$1' (holder died)"
    rm -rf "$1"
  fi
  mkdir "$1" 2>/dev/null || die "cannot create lock dir '$1'"
  winpid="$(self_winpid)"
  if [ -z "$winpid" ]; then
    rm -rf "$1"
    die "cannot determine my Windows PID (ps -W failed); refusing to run without a lock"
  fi
  echo "$winpid" > "$1/winpid"
  log "acquired $who lock: $1 (winpid $winpid)"
}

release_lock() {                     # $1 = lock dir
  if [ -d "$1" ] && [ "$(cat "$1/winpid" 2>/dev/null)" = "$(self_winpid)" ]; then
    rm -rf "$1"
    log "released lock: $1"
  fi
}

# Refuse to start while an OLD run_agent.sh / run_sequential.sh driver is alive
# in this repo (its legacy lock would be live). --force skips this and the new lock.
check_legacy_locks() {
  [ "$FORCE" = true ] && { log "!! --force given: skipping legacy lock checks"; return 0; }
  if lock_held_by_live_pid ".run_agent.lock"; then
    die "a legacy run_agent.sh driver (winpid $(cat ".run_agent.lock/winpid" 2>/dev/null)) is still running in this repo. Let it finish first or remove the stale lock: rm -rf .run_agent.lock"
  fi
  if lock_held_by_live_pid ".run_sequential.lock"; then
    die "a legacy run_sequential.sh driver (winpid $(cat ".run_sequential.lock/winpid" 2>/dev/null)) is still running in this repo. Let it finish first or remove the stale lock: rm -rf .run_sequential.lock"
  fi
}

show_help() {
while IFS= read -r line; do
  printf '%s\n' "$line"
done <<'HELP'
run_sweep.sh - merged autonomous agent driver (Pi harness, OpenCode fallback)
=============================================================================

WHAT IT IS
----------
run_sweep.sh drives an autonomous coding agent through a long implementation
plan described in prompts.json, without ever letting a single agent "run out
of context" (KILL_MODE=budget) or, opt-in, trusting Pi's automatic compaction
to manage context (KILL_MODE=compact).

FOUR MODES (exactly one required)
--------------------------------
  ./run_sweep.sh --prompts FILE [--step N] [--role R] ...
      Single-module sweep (the old run_agent.sh behaviour): iterates the
      "prompts" array in FILE, one step at a time, through the context-window
      watchdog. Each step may carry its own "role" (see prompts JSON).
  ./run_sweep.sh --sequence [FILE] [--from M] [--resumes N] [--backoff S] [--force] ...
      Sequence sweep (the old run_sequential.conf behaviour): drives the modules
      listed in run_sequential.conf (or FILE) back-to-back, in-process, with
      auto-resume per module.
  ./run_sweep.sh --sequencemd [FILE]
      Like --sequence, but FILE (default run_sequential_md.conf) lists raw .md
      prompt files executed VERBATIM, one agent per file, top-to-bottom
      (optional per-line "ROLE|path.md" prefix). Designed for document-authoring
      phases such as design-plan generation: no planner decomposition, each md
      IS the prompt. After the sweep it (re)writes run_planner.conf from the
      design plans on disk (SEQMD_PLANS_DIR, default
      design_documents/design_plans) so --planner can run next.
  ./run_sweep.sh --planner [FILE] [--from M] [--force] [--out-dir DIR] [--dry-run]
      Step 2 planner: for each design plan in run_planner.conf (or FILE), spawn
      the models.json "planner" agent to write a prompts JSON (with per-task
      roles), then rewrite run_sequential.conf so --sequence can implement them.
  ./run_sweep.sh --chat FILE [--conversation-id ID] [--role R] [--title T]
                        [--new] [--compact-now]
      Headless chat (DP-CHAT): FILE's verbatim contents are the user turn. One
      harness session per conversation; follow-up turns with the same
      --conversation-id continue the SAME session (provider prompt-cache
      friendly). Full transcript in .chat/<id>/ (meta.json, history.jsonl,
      history.md); overflow compacts (summary + verbatim tail into a fresh
      session) instead of recycling handouts. The assistant reply goes to stdout.
  Read-only chat utilities (no mode flag / no lock):
    --list-conversations            table of .chat/*/meta.json
    --print-history                 render + print .chat/<id>/history.md
                                    (requires --conversation-id ID)

HARNESS (--harness pi|opencode, env AAD_HARNESS, default pi)
-----------------------------------------------------------
  pi       `pi --mode json --approve --session-dir <dir> --model <provider/id>`
           Session identity, usage, errors and activity come from Pi's on-disk
           session JSONL under $WORKDIR/.pi_sessions (never $HOME, never argv).
  opencode OpenCode CLI fallback (unchanged behaviour of the old driver).

WATCHDOG (--kill-mode budget|compact, default budget)
-----------------------------------------------------
  budget  stop the agent when cumulative usage crosses the resolved threshold:
          --limit N > role context_window_handout > KILL_PCT% of models.json
          context_window > 150000. Then continue the SAME session to write the
          progress handout and recycle to a fresh window. Comparable to the
          OpenCode numbers.
  compact (Pi only) no usage-based recycle; Pi compacts automatically. Only an
          explicit --limit is a hard ceiling. One session per step.

ANTI-SKIP GATE
--------------
A step whose agent produced ZERO repository file changes is never accepted on
its own word ("already implemented"): the driver automatically re-dispatches
that step ONCE with the AUDIT prompt (verify every requirement, run the tests)
and only then records SUCCESS_AUDIT. Guards against lazy skips and stale-handout
rationalisation; verified pre-existing work passes after one cheap audit.
DELIBERATE-STOP GUARD: a clean exit that leaves handout_active.md UPDATED gets
one AUDIT re-dispatch (verify this step, run the tests, delete the handout)
instead of a blind continue-nudge - an updated handout means the agent meant to
finish, and nudging it made it implement every later step in one turn.

CRASH RESILIENCE / STATE
------------------------
Every transition writes run_state.json (mode, module, current_step, completed,
stage, full handout). --resume/--restore/--audit behave exactly as before.
handout.md / handout_active.md / .run_summaries/ / .step_sids.tmp / .supervisor/
are unchanged. Sequence state lives in .sequential_results.txt (MODULE|STATUS|AT)
and .sequential_run.log.

DRIVER JOURNAL (.chat/ mirror)
------------------------------
Every non-chat mode also records its progress as a .chat/<id>/ conversation in
the SAME format as --chat conversations, so chat_window.html shows planner /
sequence / single-module sweeps right next to your chats. Sweeps use their
module id as the entry id; a whole --planner run gets "planner-YYMMDD-HHMMSS".
Dispatched steps appear as user messages, per-step summaries as assistant
messages, interruptions/failures as error notices; the fresh-dot marks a live
agent session while it works.

OPTIONS
-------
  --prompts FILE     Use FILE instead of prompts.json (single-module mode).
  --sequence [FILE]  Sequence mode; FILE defaults to run_sequential.conf
                     (also --sequence=FILE).
  --planner [FILE]   Planner mode (Step 2); FILE defaults to run_planner.conf
                     (also --planner=FILE). Writes prompts JSON + updates
                     run_sequential.conf.
  --chat FILE        Chat mode: the verbatim contents of FILE are the user turn
                     (markdown recommended). Alias: --prompt FILE (never give
                     both spellings in one invocation).
  --conversation-id ID  Logical conversation key ([A-Za-z0-9_-]+). Default:
                     auto chat-YYYYMMDD-HHMMSS. Reusing an id continues that
                     conversation; directory .chat/<id>/ holds meta.json,
                     history.jsonl, history.md and (after a compaction)
                     summary.md.
  --title TEXT       Optional label for the conversation (stored in meta.json,
                     shown by --list-conversations).
  --new              Fail instead of continuing if --conversation-id already
                     exists (guards typos).
  --compact-now      Force a compaction pass BEFORE executing this turn
                     (escape hatch when answers feel degraded).
  --print-history    Print the rendered history.md of --conversation-id ID to
                     stdout and exit (no turn is run, no lock is taken).
  --list-conversations  Print id/title/role/model/turns/status of every
                     conversation under .chat/ and exit.
  --out-dir DIR      Planner: default directory for prompts_<MODULE>.json when
                     a conf line omits the output path (default: .run_sweep).
  --dry-run          Planner: validate conf and print the plan; spawn no agents.
  --step N           Start a fresh sweep at 1-based step N (prompts mode only).
                     With --restore, still starts at N (does not resume a
                     leftover run_state.json from a different module).
  --role NAME        Resolve model + handout threshold from models.json.
                     In --prompts/--sequence this is the fallback when a step
                     omits "role". In --chat it pins the conversation model on
                     turn 1 and must keep matching on later turns. Ignored for
                     the planner agent itself (always models.json planner_role /
                     "planner").
  --limit N          Fixed kill threshold (budget) / hard ceiling (compact).
  --poll S           Mid-tier polling interval in seconds (default 10).
   --stall-timeout S  Seconds of zero observable progress before graceful shutdown.
                      In Pi mode a running tool call is exempt: usage+log stay
                      frozen until the tool returns, so a long local command (e.g.
                      a 30-min test run) is not a stall. TOOL_STALL_TIMEOUT_S (env,
                      default 3600) bounds a single in-flight tool call instead.
   --continue-nudges N  Same-session "continue" budget as a ROLLING RATE: at
                       most N sends within any CONTINUE_NUDGE_WINDOW_S seconds
                       (default: 3 per 60s), used whenever the agent stalls
                       mid-task - a clean premature exit with handout_active.md
                       still present AND unchanged (an UPDATED handout routes to
                       the deliberate-stop AUDIT re-dispatch instead), or a
                       TRANSIENT provider stream drop ("Stream ended without
                       finish_reason"). Absolute cap per context window:
                       CONTINUE_MAX_TOTAL (default 40). 0 disables.
   --model-backoff S  Wait between retries after a model/API failure.
   --max-model-failures N  Consecutive failed sessions before giving up to --resume
                      (default 10).
  --harness pi|opencode   Select the backend CLI (default pi).
  --kill-mode budget|compact  Watchdog mode (default budget).
  --pi-session-dir DIR  Override the Pi session dir (default $WORKDIR/.pi_sessions).
  --audit            AUDIT sweep: every step verifies/repairs existing code.
  --resume           Continue from run_state.json.
  --restore          Like --resume but forces a restore pass on the current step.
   --from MODULE      Start the sequence/planner at MODULE (sequence/planner mode).
   --resumes N        Max --resume attempts per module after a non-zero exit
                      (sequence mode only).
   --backoff S        Seconds between resume attempts (default 300; sequence only).
   --force            Re-run DONE modules / overwrite existing planner outputs +
                      skip all lock guards (sequence and planner).
    --supervise        Enable the autonomous supervisor (DP-SUPERVISOR).
    --debug            Write diagnostics to $DEBUG_FILE (never stdout): every
                       spawned command, watchdog decision, the transcript
                       summary and the in-flight tool call at each failure.
                       Also enable with AAD_DEBUG=1.
    --clean            Reset for a truly fresh single-module start.
    --git-init-add-per-module
                       If needed run git init, then after each module do
                       git add . + git commit -m "module <name> implemented".
                       Skips git init when .git already exists.

IPC SENTINEL CONTROL PLANE (no flag needed; see design_documents/draft_debugging_and_steering.md)
-----------------------------------------------------------------------------------------------
Drop a sentinel file into .control/ to steer a RUNNING driver live, without
restarting it. The driver polls every watchdog cycle + at each step boundary:
  .control/DEBUG       set DEBUG=1 on the fly (streams to .debug_run.log).
  .control/REPORT      write status_report.md (live usage, in-flight tool
                       calls, last-window activity) + a full debug state dump.
  .control/INSTRUCT    inject .intramessages/instructions.md (create it first)
                       into the live handover context (handout_active.md).
  .control/PAUSE       freeze the driver loop; the agent keeps running. Remove
                       the file to resume.
  .control/INTERRUPT   soft-interrupt (SIGINT) the stuck agent sub-process so
                       its tool call fails gracefully back to the agent loop.
.prompt_flight.md     (chat mode, pi) drop while a turn is RUNNING: contents
                      are delivered INTO the live session at the next poll
                      tick (SIGINT soft-stop + same-session continue). File is
                      consumed on read; older than 10 min = ignored (stale).
Tool telemetry (also written to .debug_run.log even without --debug): the exact
command of any in-flight tool call is logged after TOOL_LOG_S (60s) and a
process-tree snapshot is appended after TOOL_DIAG_S (10min).
  --help|-h          Print this help and exit.

EXIT CODES
----------
  0   all steps complete / turn completed and reply recorded (or --help)
  1   fatal error / graceful shutdown (model stall / interrupt / max failures).
      Chat: the failed turn never entered history.jsonl - re-run the same
      --chat command to retry it.
HELP
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) show_help ;;
    --prompts) PROMPTS_FILE="$2"; PROMPTS_GIVEN=true; shift 2 ;;
    --sequence=*) SEQUENCE_CONF="${1#--sequence=}"; SEQUENCE_MODE=true; shift ;;
    --sequence) SEQUENCE_MODE=true; shift; if [ $# -gt 0 ] && [[ "$1" != -* ]]; then SEQUENCE_CONF="$1"; shift; fi ;;
    --sequencemd=*) SEQMD_MODE=true; SEQMD_CONF="${1#--sequencemd=}"; shift ;;
    --sequencemd) SEQMD_MODE=true; shift; if [ $# -gt 0 ] && [[ "$1" != -* ]]; then SEQMD_CONF="$1"; shift; fi ;;
    --planner=*) PLANNER_CONF="${1#--planner=}"; PLANNER_MODE=true; shift ;;
    --planner) PLANNER_MODE=true; shift; if [ $# -gt 0 ] && [[ "$1" != -* ]]; then PLANNER_CONF="$1"; shift; fi ;;
    --out-dir) PLANNER_OUT_DIR="$2"; shift 2 ;;
    --dry-run) PLANNER_DRY_RUN=true; shift ;;
    --harness) HARNESS="$2"; shift 2 ;;
    --kill-mode) KILL_MODE="$2"; shift 2 ;;
    --pi-session-dir) PI_SESSION_DIR="$2"; shift 2 ;;
    --step)    START_STEP="$2"; STEP_GIVEN=true; shift 2 ;;
    --role)    ROLE="$2"; shift 2 ;;
    --limit)   LIMIT_ARG="$2"; HARD_LIMIT="$2"; shift 2 ;;
    --poll)    POLL_EVERY_S="$2"; POLL_GIVEN=true; shift 2 ;;
    --stall-timeout) STALL_TIMEOUT_S="$2"; shift 2 ;;
    --continue-nudges) MAX_CONTINUE_NUDGES="$2"; shift 2 ;;
    --model-backoff) MODEL_FAILURE_BACKOFF_S="$2"; shift 2 ;;
    --max-model-failures) MAX_MODEL_FAILURES="$2"; shift 2 ;;
    --audit)   MODE="audit"; shift ;;
    --resume)  RESUME=true; shift ;;
    --restore) RESTORE=true; shift ;;
    --force)   FORCE=true; shift ;;
    --from)    FROM="$2"; FROM_GIVEN=true; shift 2 ;;
    --resumes) MAX_RESUMES="$2"; RESUMES_GIVEN=true; shift 2 ;;
    --backoff) BACKOFF_S="$2"; BACKOFF_GIVEN=true; shift 2 ;;
     --supervise) SUPERVISE=true; shift ;;
     --debug)   DEBUG=1; shift ;;
     --git-init-add-per-module) GIT_INIT_ADD_PER_MODULE=true; shift ;;
     --chat) CHAT_FILE="$2"; CHAT_MODE=true; CHAT_SPELLING="${CHAT_SPELLING}chat"; shift 2 ;;
    --prompt) CHAT_FILE="$2"; CHAT_MODE=true; CHAT_SPELLING="${CHAT_SPELLING}prompt"; shift 2 ;;
    --conversation-id) CONVERSATION_ID="$2"; shift 2 ;;
    --title) CHAT_TITLE="$2"; shift 2 ;;
    --new) CHAT_NEW=true; shift ;;
    --compact-now) COMPACT_NOW=true; shift ;;
    --print-history) PRINT_HISTORY=true; shift ;;
    --list-conversations) LIST_CONVERSATIONS=true; shift ;;
    --clean)   MODE="build"; RESUME=false; RESTORE=false; CLEAN_GIVEN=true; rm -f "$STATE_FILE" "$HANDOVER_FILE" "handout_active.md" "$STEP_RECORDS_FILE"; rm -rf "$SUMMARY_DIR"; shift ;;
     *) die "unknown flag: $1 (use --help/-h; flags: --prompts/--sequence/--planner/--chat/--prompt/--conversation-id/--title/--new/--compact-now/--print-history/--list-conversations/--out-dir/--dry-run/--step/--role/--limit/--poll/--stall-timeout/--continue-nudges/--model-backoff/--max-model-failures/--harness/--kill-mode/--pi-session-dir/--audit/--resume/--restore/--force/--from/--resumes/--backoff/--supervise/--debug/--clean/--git-init-add-per-module)" ;;
  esac
done

case "$HARNESS" in
  pi|opencode) ;;
  *) die "invalid --harness '$HARNESS' (expected pi|opencode)" ;;
esac
case "$KILL_MODE" in
  budget|compact) ;;
  *) die "invalid --kill-mode '$KILL_MODE' (expected budget|compact)" ;;
esac
if [ "$HARNESS" = "opencode" ] && [ "$KILL_MODE" = "compact" ]; then
  die "--kill-mode compact is only supported with --harness pi (the OpenCode fallback path only supports budget)"
fi
case "$MAX_RESUMES" in
  ''|*[!0-9]*) die "--resumes must be a non-negative integer" ;;
esac
case "$BACKOFF_S" in
  ''|*[!0-9]*) die "--backoff must be a non-negative integer" ;;
esac
case "$MAX_CONTINUE_NUDGES" in
  ''|*[!0-9]*) die "--continue-nudges must be a non-negative integer" ;;
esac
case "$CONTINUE_NUDGE_WINDOW_S" in
  ''|*[!0-9]*) die "CONTINUE_NUDGE_WINDOW_S must be a non-negative integer (env)" ;;
esac
case "$CONTINUE_MAX_TOTAL" in
  ''|*[!0-9]*) die "CONTINUE_MAX_TOTAL must be a non-negative integer (env)" ;;
esac

# Mode selection: exactly one of --prompts, --sequence, --planner, or --chat.
# --print-history / --list-conversations are read-only chat utilities: they run
# without a mode flag and without the driver lock, but never combined with a
# mode or with each other.
_mode_count=0
[ "$SEQUENCE_MODE" = true ] && _mode_count=$((_mode_count + 1))
[ "$SEQMD_MODE" = true ] && _mode_count=$((_mode_count + 1))
[ "$PROMPTS_GIVEN" = true ] && _mode_count=$((_mode_count + 1))
[ "$PLANNER_MODE" = true ] && _mode_count=$((_mode_count + 1))
[ "$CHAT_MODE" = true ] && _mode_count=$((_mode_count + 1))
_chat_utility_count=0
[ "$PRINT_HISTORY" = true ] && _chat_utility_count=$((_chat_utility_count + 1))
[ "$LIST_CONVERSATIONS" = true ] && _chat_utility_count=$((_chat_utility_count + 1))
if [ "$_chat_utility_count" -gt 0 ]; then
  [ "$_chat_utility_count" -eq 1 ] || die "--print-history and --list-conversations are mutually exclusive; give exactly one"
  [ "$_mode_count" -eq 0 ] || die "--print-history/--list-conversations cannot be combined with a mode flag (--prompts/--sequence/--sequencemd/--planner/--chat)"
elif [ "$_mode_count" -ne 1 ]; then
  die "give exactly one of --prompts FILE, --sequence [FILE], --sequencemd [FILE], --planner [FILE], or --chat FILE"
fi
case "$CHAT_SPELLING" in
  chatprompt|promptchat) die "--chat and --prompt are aliases for the same thing; give only one of them" ;;
esac
# Sequence/planner-only flags are rejected in single-module mode.
if [ "$PROMPTS_GIVEN" = true ]; then
  [ -n "$FROM" ] && [ "$FROM_GIVEN" = true ] && die "--from is only valid with --sequence or --planner"
  [ "$FORCE" = true ] && die "--force is only valid with --sequence or --planner"
  [ "$RESUMES_GIVEN" = true ] && die "--resumes is only valid in sequence mode (with --sequence)"
  [ "$BACKOFF_GIVEN" = true ] && die "--backoff is only valid in sequence mode (with --sequence)"
  [ -n "$PLANNER_OUT_DIR" ] && die "--out-dir is only valid with --planner"
  [ "$PLANNER_DRY_RUN" = true ] && die "--dry-run is only valid with --planner"
fi
if [ "$SEQUENCE_MODE" = true ]; then
  [ -n "$PLANNER_OUT_DIR" ] && die "--out-dir is only valid with --planner"
  [ "$PLANNER_DRY_RUN" = true ] && die "--dry-run is only valid with --planner"
  [ "$STEP_GIVEN" = true ] && die "--step is only valid with --prompts (use --from MODULE for sequence)"
fi
if [ "$SEQMD_MODE" = true ]; then
  # --force IS allowed here: it re-dispatches every md step even if this exact
  # module+step pair completed in a previous run (e.g. offline smokes).
  [ "$FROM_GIVEN" = true ] && die "--from is only valid with --sequence or --planner"
  [ "$RESUMES_GIVEN" = true ] && die "--resumes is only valid in sequence mode (with --sequence)"
  [ "$BACKOFF_GIVEN" = true ] && die "--backoff is only valid in sequence mode (with --sequence)"
  [ -n "$PLANNER_OUT_DIR" ] && die "--out-dir is only valid with --planner"
  [ "$PLANNER_DRY_RUN" = true ] && die "--dry-run is only valid with --planner"
  [ "$STEP_GIVEN" = true ] && die "--step is only valid with --prompts"
  [ "$MODE" = "audit" ] && die "--audit is not used in sequencemd mode (the md files ARE the spec)"
fi
if [ "$PLANNER_MODE" = true ]; then
  [ "$RESUMES_GIVEN" = true ] && die "--resumes is only valid in sequence mode (with --sequence)"
  [ "$BACKOFF_GIVEN" = true ] && die "--backoff is only valid in sequence mode (with --sequence)"
  [ "$STEP_GIVEN" = true ] && die "--step is only valid with --prompts"
  [ "$RESUME" = true ] && die "--resume is not used in planner mode (use --from / --force)"
  [ "$RESTORE" = true ] && die "--restore is not used in planner mode"
  [ "$MODE" = "audit" ] && die "--audit is not used in planner mode"
  [ "$SUPERVISE" = true ] && die "--supervise is not used in planner mode"
fi
if [ "$CHAT_MODE" = true ]; then
  [ "$STEP_GIVEN" = true ] && die "--step is only valid with --prompts"
  [ "$FROM_GIVEN" = true ] && die "--from is only valid with --sequence or --planner"
  [ "$RESUMES_GIVEN" = true ] && die "--resumes is only valid in sequence mode (with --sequence)"
  [ "$BACKOFF_GIVEN" = true ] && die "--backoff is only valid in sequence mode (with --sequence)"
  [ -n "$PLANNER_OUT_DIR" ] && die "--out-dir is only valid with --planner"
  [ "$PLANNER_DRY_RUN" = true ] && die "--dry-run is only valid with --planner"
  [ "$MODE" = "audit" ] && die "--audit is not used in chat mode"
  [ "$RESUME" = true ] && die "--resume is not used in chat mode (continuity is implicit via --conversation-id)"
  [ "$RESTORE" = true ] && die "--restore is not used in chat mode"
  [ "$CLEAN_GIVEN" = true ] && die "--clean is not used in chat mode (delete .chat/<id> manually if needed)"
  [ "$SUPERVISE" = true ] && die "--supervise is not supported in chat mode (v1)"
  # Conversation id rules (DP-CHAT §8.2): [A-Za-z0-9_-]+, directory name == id.
  if [ -z "$CONVERSATION_ID" ]; then
    CONVERSATION_ID="chat-$(date +%Y%m%d-%H%M%S)"
    log "[chat] no --conversation-id given; auto-generated $CONVERSATION_ID"
  fi
  case "$CONVERSATION_ID" in
    *[!A-Za-z0-9_-]*) die "bad --conversation-id '$CONVERSATION_ID' (allowed: [A-Za-z0-9_-], no spaces)" ;;
  esac
  case "$KILL_MODE" in
    budget|compact) : ;;
    *) die "invalid --kill-mode '$KILL_MODE'" ;;
  esac
fi
if [ "$CHAT_MODE" != true ] && [ "$_chat_utility_count" -eq 0 ]; then
  [ -n "$CONVERSATION_ID" ] && die "--conversation-id is only valid with --chat"
  [ -n "$CHAT_TITLE" ] && die "--title is only valid with --chat"
  [ "$CHAT_NEW" = true ] && die "--new is only valid with --chat"
  [ "$COMPACT_NOW" = true ] && die "--compact-now is only valid with --chat"
fi
[ "$PRINT_HISTORY" = true ] && [ -z "$CONVERSATION_ID" ] && die "--print-history requires --conversation-id ID"
[ "$PRINT_HISTORY" = true ] && case "$CONVERSATION_ID" in *[!A-Za-z0-9_-]*) die "bad --conversation-id '$CONVERSATION_ID' (allowed: [A-Za-z0-9_-])" ;; esac

GLOBAL_ROLE="$ROLE"
GLOBAL_KILL_MODE="$KILL_MODE"
GLOBAL_POLL_EVERY_S="$POLL_EVERY_S"   # base poll interval, restored per module unless the profile overrides it

# Debug mode start-up banner. It runs AFTER arg parsing so --debug is honoured,
# and is the first thing an analyst sees in $DEBUG_FILE for a given driver run.
if [ "$DEBUG" = "1" ]; then
  dbg_sep "run_sweep.sh debug start $(date '+%Y-%m-%d %H:%M:%S')"
  dbg "argv: $*"
  dbg "harness=$HARNESS kill_mode=$KILL_MODE mode=$MODE supervise=$SUPERVISE sequence=$SEQUENCE_MODE"
  dbg "prompts=$PROMPTS_FILE sequence_conf=$SEQUENCE_CONF role=${ROLE:-} limit=${HARD_LIMIT:-}"
  dbg "pi_session_dir=$PI_SESSION_DIR workdir=$WORKDIR"
  dbg "debug file: $DEBUG_FILE"
fi

# Environment hardening for Pi (headless runs: no update check, no telemetry,
# long cache retention). AAD_HARNESS / PI_SESSION_DIR are exported so the
# supervisor fixer path inherits them.
if [ "$HARNESS" = "pi" ]; then
  export PI_SKIP_VERSION_CHECK=1
  export PI_TELEMETRY=0
  export PI_CACHE_RETENTION="$PI_CACHE_RETENTION"
fi
export AAD_HARNESS="$HARNESS"
export PI_SESSION_DIR="$PI_SESSION_DIR"

# Adaptive poll tiers: low tier (<30% of window) polls slowest so the agent can
# work freely; the top tier (>=70%) polls fastest so the KILL_PCT crossing is
# caught within ~3s instead of overshooting the whole window in one flat poll.
POLL_TOP_S=$(( POLL_EVERY_S / 3 )); [ "$POLL_TOP_S" -lt 1 ] && POLL_TOP_S=1
POLL_LOW_S=$(( POLL_EVERY_S * 3 ))

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

# Run an `opencode run` command (OpenCode fallback path). `winpty` gives the
# Windows CLI a real console when we're in an interactive terminal, but the
# watchdog backgrounds these sessions with output redirected, where winpty
# aborts with "stdin is not a tty". So use winpty only when a TTY is present
# and opencode directly otherwise.
#
# `exec` makes the CALLING subshell BECOME the native process. Combined with
# `ps -W` / `taskkill //F //T` this lets the watchdog kill the real process
# tree (opencode.exe + winpty + grandchildren), instead of only the bash job
# which would leave native agents orphaned and burning tokens.
run_opencode() {
  dbg "spawn opencode: opencode $*"
  if [ "$PLATFORM_WIN" = 1 ] && [ -t 0 ] && [ -t 1 ]; then
    exec winpty opencode "$@"
  else
    exec opencode "$@"
  fi
}

# Run a `pi` command (Pi harness path). `--approve` and `--session-dir` are
# guaranteed on every Pi invocation. PI_TEST_CMD lets tests substitute an
# offline stub for `pi` (same idea as SUPERVISOR_CMD).
run_pi() {
  dbg "spawn pi: pi --approve --session-dir \"$PI_SESSION_DIR\" $*"
  if [ -n "$PI_TEST_CMD" ]; then
    dbg "  (PI_TEST_CMD override: bash -c \"$PI_TEST_CMD ...\" pi --approve --session-dir \"$PI_SESSION_DIR\" $*)"
    # Mirror the real invocation so an offline stub sees the SAME argv as pi
    # (previously --approve/--session-dir were dropped and the stub wrote to
    # the default dir, which the driver then could not find -> "no work").
    exec bash -c "$PI_TEST_CMD \"\$@\"" pi --approve --session-dir "$PI_SESSION_DIR" "$@"
  elif [ "$PLATFORM_WIN" = 1 ] && [ -t 0 ] && [ -t 1 ]; then
    exec winpty pi --approve --session-dir "$PI_SESSION_DIR" "$@"
  else
    exec pi --approve --session-dir "$PI_SESSION_DIR" "$@"
  fi
}

# Prune stale bulk content from a resumed pi session JSONL, in place (.bak kept
# beside it): tool-result bodies larger than PI_PRUNE_TOOL_OVER_CHARS outside the
# newest PI_PRUNE_KEEP_RESULTS results become one-line stubs; thinking blocks
# outside the newest PI_PRUNE_KEEP_THINKING assistant steps are stubbed. Safe
# because durable knowledge is externalised to FINDINGS.md/RUN-REPORT.md; the
# stubs say what was removed so the agent can re-derive via tools if ever needed.
# Called only on --session resumes (fresh sessions have nothing to prune) - i.e.
# at error/nudge/turn boundaries where breaking the prefix cache is acceptable.
prune_session_history() {   # $1 = session id (partial UUID ok)
  [ "${PI_PRUNE:-1}" = "1" ] || return 0
  [ "$HARNESS" = "pi" ] || return 0
  [ -d "$PI_SESSION_DIR" ] || return 0
  local f
  f="$(ls -t "$PI_SESSION_DIR"/*"$1"*.jsonl 2>/dev/null | head -1)"
  [ -n "$f" ] || return 0
  local kb
  kb=$(( $(wc -c <"$f") / 1024 ))
  [ "$kb" -ge "${PI_PRUNE_MIN_FILE_KB:-200}" ] || return 0
  local keep_r="${PI_PRUNE_KEEP_RESULTS:-5}" over_c="${PI_PRUNE_TOOL_OVER_CHARS:-1024}" keep_t="${PI_PRUNE_KEEP_THINKING:-10}"
  local summary
  summary="$(PYTHONIOENCODING=utf-8 python3 - "$f" \
    "$keep_r" "$over_c" "$keep_t" <<'PYEOF'
import json, shutil, sys

path = sys.argv[1]
keep_results = int(sys.argv[2])
tool_over = int(sys.argv[3])
keep_thinking = int(sys.argv[4])
TOOL_STUB = "[pruned by archiver: {kb} KB of tool output elided - re-derive via tools if needed]"
THINK_STUB = "[pruned reasoning]"

shutil.copy2(path, path + ".bak")
entries = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]

tr_idx = [i for i, e in enumerate(entries)
          if e.get("type") == "message" and (e.get("message") or {}).get("role") == "toolResult"]
as_idx = [i for i, e in enumerate(entries)
          if e.get("type") == "message" and (e.get("message") or {}).get("role") == "assistant"]

tr_cut = len(tr_idx) - keep_results
as_cut = len(as_idx) - keep_thinking
n_tr = n_th = saved_tr = saved_th = 0

for rank, i in enumerate(tr_idx):
    if rank >= tr_cut:
        continue
    m = entries[i]["message"]
    c = m.get("content")
    parts = c if isinstance(c, list) else None
    if parts is None:
        parts = [{"type": "text", "text": c}] if isinstance(c, str) else []
        m["content"] = parts
    for p in parts:
        if isinstance(p, dict) and p.get("type") == "text" and len(p.get("text", "")) > tool_over:
            saved_tr += len(p["text"])
            p["text"] = TOOL_STUB.format(kb=len(p["text"]) // 1024)
            n_tr += 1

if keep_thinking > 0:
    for rank, i in enumerate(as_idx):
        if rank >= as_cut:
            continue
        for p in (entries[i]["message"].get("content") or []):
            if isinstance(p, dict) and p.get("type") == "thinking":
                t = p.get("thinking", "") or ""
                if t:
                    saved_th += len(t)
                    p["thinking"] = THINK_STUB
                    n_th += 1

with open(path, "w", encoding="utf-8") as f:
    for e in entries:
        f.write(json.dumps(e, ensure_ascii=False) + "\n")

print(f"pruned: {n_tr} tool results (-{saved_tr // 1024} KB), {n_th} thinking blocks (-{saved_th // 1024} KB); file {(saved_tr + saved_th) // 1024} KB lighter (.bak kept)")
PYEOF
)" || { dbg "prune_session_history: python failed on $f"; return 0; }
  dbg "prune_session_history sid=$1 $summary"
}

# Prepend CHAT_INJECT_FILE contents (if configured/readable) to a driver-sent
# prompt so the agent always carries the durable-state digest in-window even
# after pruning stubbed the raw material it was distilled from.
with_context_injection() {
  local p="$1"
  if [ -n "${CHAT_INJECT_FILE:-}" ] && [ -r "$CHAT_INJECT_FILE" ]; then
    printf '%s\n\n---\n\n%s' "$(head -c "${CHAT_INJECT_MAX_CHARS:-24576}" "$CHAT_INJECT_FILE")" "$p"
  else
    printf '%s' "$p"
  fi
}

# Dispatcher: run_agent_cli <prompt> [extra flags...]
# In Pi mode the caller passes either --session <id> (handout writer) or nothing
# (new session). Never pass --session for the main agent.
# Reasoning effort comes from model_profiles.<name>.effort: mapped to the OpenCode
# `--variant` (model-specific reasoning-effort preset) or Pi `--thinking` flag.
# Empty/"default" means "leave the model default", so effort-less profiles stay as
# they always behaved.
run_agent_cli() {
  local eff=()
  if [ -n "$EFFORT" ] && [ "$EFFORT" != "default" ]; then
    if [ "$HARNESS" = "pi" ]; then
      eff=(--thinking "$EFFORT")
    else
      eff=(--variant "$EFFORT")
    fi
  fi
  if [ "$HARNESS" = "pi" ]; then
    local a prev="" sid=""
    for a in "$@"; do
      [ "$prev" = "--session" ] && sid="$a"
      prev="$a"
    done
    [ -n "$sid" ] && prune_session_history "$sid"
    dbg "agent run (pi): --mode json --model \"$MODEL_NAME\" ${eff[*]+"${eff[@]}"} $*"
    run_pi --mode json --model "$MODEL_NAME" "${eff[@]}" "$@"
  else
    dbg "agent run (opencode): run --auto --model \"$MODEL_NAME\" ${eff[*]+"${eff[@]}"} $*"
    run_opencode run --auto --model "$MODEL_NAME" "${eff[@]}" "$@"
  fi
}

# --- supervisor helpers (DP-SUPERVISOR) ----------------------------------
# The supervisor journal is the human's single source of truth: heartbeats for
# green steps and full incident records for handled issues.
sup_log() {
  mkdir -p "$SUPERVISOR_DIR"
  echo "[$(date '+%H:%M:%S')] $*" >>"$SUPERVISOR_LOG"
}

# Layer 1 triage. The AUTHORITATIVE signal is the session transcript's error
# (opencode info.error, or Pi stopReason=="error"). A step that ended with such
# a recorded error is `transient`; anything else is `needs_judgement`.
sup_classify() {
  local sid err
  if [ -f "$SID_LIST_FILE" ]; then
    while read -r sid; do
      [ -n "$sid" ] || continue
      err="$(session_errored "$sid")"
      if [ -n "$err" ]; then
        echo "transient"
        return 0
      fi
    done <"$SID_LIST_FILE"
  fi
  echo "needs_judgement"
}

sup_transcript_errors() {   # one "sid: error" line per errored session ("" if none)
  local sid err
  [ -f "$SID_LIST_FILE" ] || return 0
  while read -r sid; do
    [ -n "$sid" ] || continue
    err="$(session_errored "$sid")"
    [ -n "$err" ] && echo "$sid: $err"
  done <"$SID_LIST_FILE"
}

# Write the per-incident evidence file the supervisor bases its decision on.
sup_write_incident() {   # $1 = step
  local step="$1" f errs
  INCIDENT_N=$(( INCIDENT_N + 1 ))
  f="$SUPERVISOR_DIR/incident_${INCIDENT_N}.md"
  errs="$(sup_transcript_errors | wc -l | tr -d ' ')"
  {
    echo "# Incident ${INCIDENT_N} - step ${step} INTERRUPTED"
    echo ""
    echo "- module: $MODULE"
    echo "- prompts: $PROMPTS_FILE"
    echo "- step: ${step}/${TOTAL}"
    echo "- stage: ${STAGE:-none}"
    echo "- time: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "- state: $STATE_FILE (current_step=${CURRENT_STEP:-0}, completed=[${COMPLETED_CSV:-}])"
    echo "- model errors recorded in this step's transcripts: $errs (authoritative)"
    echo ""
    echo "## Sessions in this step"
    cat "$SID_LIST_FILE" 2>/dev/null | sed 's/^/- `/; s/$/`/'
    echo ""
    echo "## Step summary"
    cat "$SUMMARY_DIR/step_summary_${MODULE}_${step}.md" 2>/dev/null | sed 's/^/> /'
    echo ""
    echo "## Verdict"
    echo "- needs_judgement (no transcript model error) -> the supervisor opens a menu."
  } >"$f"
  sup_log "incident written: $f"
  echo "$f"
}

# Reconstruct the driver's original flags (minus state/reset flags) for RESET.
sup_relaunch_args() {
  local a=""
  [ -n "$ROLE" ] && a="$a --role $ROLE"
  [ "$MODE" = "audit" ] && a="$a --audit"
  [ -n "$HARD_LIMIT" ] && a="$a --limit $HARD_LIMIT"
  a="$a --harness $HARNESS --kill-mode $KILL_MODE"
  a="$a --poll $POLL_EVERY_S --stall-timeout $STALL_TIMEOUT_S --model-backoff $MODEL_FAILURE_BACKOFF_S --max-model-failures $MAX_MODEL_FAILURES"
  if [ "$SEQUENCE_MODE" = true ]; then
    a="$a --sequence $SEQUENCE_CONF --from ${CURRENT_MODULE:-$FROM}"
  else
    a="$a --prompts $PROMPTS_FILE"
  fi
  [ "$DEBUG" = "1" ] && a="$a --debug"
  a="$a --supervise"
  echo "$a"
}

# Startup hook (supervise mode): runtime dir, driver.pid, relaunch.sh.
sup_init() {
  mkdir -p "$SUPERVISOR_DIR"
  rm -f "$SUPERVISOR_DIR/abort" "$SUPERVISOR_DIR/supervisor_done"
  # driver.pid: <msys_pid> <winpid>. The msys PID is what kill -USR1/-USR2/-HUP
  # accept; the Windows PID is what tasklist answers for liveness (pgrep is not
  # installed on this machine).
  echo "$$ $(self_winpid)" >"$SUPERVISOR_DIR/driver.pid"
  sup_log "driver started pid=$$ winpid=$(self_winpid) mode=$MODE module=$MODULE supervise=on"
  INCIDENT_N="$(ls "$SUPERVISOR_DIR"/incident_*.md 2>/dev/null | sed 's/.*incident_//; s/\.md//' | sort -n | tail -1)"
  INCIDENT_N="${INCIDENT_N:-0}"
  # relaunch.sh is the supervisor's detached re-invocation of this driver on RESET.
  {
    echo '#!/usr/bin/env bash'
    echo "# auto-generated by run_sweep.sh --supervise ($(date '+%Y-%m-%d %H:%M:%S'))"
    echo "cd \"$WORKDIR\" || exit 1"
    echo "exec bash \"$WORKDIR/run_sweep.sh\" $(sup_relaunch_args) --resume >>\"$SUPERVISOR_LOG\" 2>&1"
  } >"$SUPERVISOR_DIR/relaunch.sh"
  chmod +x "$SUPERVISOR_DIR/relaunch.sh" 2>/dev/null
  sup_log "relaunch command ready: $SUPERVISOR_DIR/relaunch.sh"
}

# Spawn the Layer-2 supervisor. The default is scripts/supervise.sh; an empty or
# missing supervisor degrades to "log + continue" (the driver resumes). Tests can
# substitute a stub via SUPERVISOR_CMD so no model tokens are burned.
sup_spawn_supervisor() {   # $1 = step
  local step="$1" incident="$SUPERVISOR_DIR/incident_${INCIDENT_N}.md"
  rm -f "$SUPERVISOR_DIR/supervisor_done"
  SUPERVISOR_PID=""
  if [ -n "${SUPERVISOR_CMD:-}" ]; then
    sup_log "spawning supervisor via SUPERVISOR_CMD override"
    ( bash -c "$SUPERVISOR_CMD \"\$@\"" supervisor "$incident" "$SUPERVISOR_DIR" "$SUPERVISOR_LOG" "$step" \
        >>"$SUPERVISOR_LOG" 2>&1 ) &
    SUPERVISOR_PID=$!
  elif [ -x "$WORKDIR/scripts/supervise.sh" ]; then
    sup_log "spawning supervisor: scripts/supervise.sh (incident $INCIDENT_N)"
    SUPERVISOR_MODEL="${SUPERVISOR_MODEL:-$MODEL_NAME}"
    ( "$WORKDIR/scripts/supervise.sh" "$incident" "$SUPERVISOR_DIR" "$SUPERVISOR_LOG" "$step" \
        >>"$SUPERVISOR_LOG" 2>&1 ) &
    SUPERVISOR_PID=$!
  else
    sup_log "ERROR: scripts/supervise.sh not found - cannot supervise; stopping for manual --resume"
    touch "$SUPERVISOR_DIR/abort"
    return 0
  fi
  echo "$SUPERVISOR_PID" >"$SUPERVISOR_DIR/supervisor.pid"
  sup_log "supervisor pid=$SUPERVISOR_PID"
}

# Block until the supervisor decides: RESUME (USR2) / RESET (HUP) / abort file /
# supervisor finished without pausing. A PAUSE (USR1) parks us until USR2 even
# after the supervisor exits (the "pause, wait for me" option).
sup_attend() {   # $1 = step
  local step="$1"
  SUPERVISOR_ATTEND=false      # guard against reentrant shutdown while we block
  sup_write_incident "$step"
  sup_spawn_supervisor "$step"
  echo "[supervisor] waiting for a supervisor decision - see $SUPERVISOR_DIR/menu.md and $SUPERVISOR_LOG"
  while true; do
    [ "${SUPERVISOR_RESET:-false}" = true ] && break
    [ -f "$SUPERVISOR_DIR/abort" ] && break
    if [ "${PAUSED:-false}" != true ]; then
      [ "${SUPERVISOR_RESUME:-false}" = true ] && break
      [ -f "$SUPERVISOR_DIR/supervisor_done" ] && break
    fi
    sleep 1
  done
  if [ "${SUPERVISOR_RESET:-false}" = true ]; then
    log "[supervisor] RESET - driver exiting for relaunch"
    sup_log "RESET - driver exiting for relaunch"
    print_final_summary
    exit 0
  fi
  if [ -f "$SUPERVISOR_DIR/abort" ]; then
    log "[supervisor] run aborted by choice - leaving for manual --resume"
    sup_log "run aborted by choice - leaving for manual --resume"
    print_final_summary
    exit 1
  fi
  echo "[supervisor] RESUMED - continuing the run"
  sup_log "RESUMED - continuing the run"
  rm -f "$SUPERVISOR_DIR/menu.md"
  return 0
}

# Honor a PAUSE request at a safe checkpoint (between steps / before a session).
wait_if_paused() {
  [ "$SUPERVISE" = true ] || return 0
  if [ "${PAUSED:-false}" = true ]; then
    echo "[supervisor] PAUSED - waiting for fix (kill -USR2 to resume)"
    sup_log "PAUSED - waiting for fix (kill -USR2 $$ to resume)"
    while [ "${PAUSED:-false}" = true ]; do
      sleep 1
    done
    echo "[supervisor] RESUMED - continuing"
    sup_log "RESUMED - continuing"
  fi
}

# Honor an abort / RESET request at a safe checkpoint (top of the outer loop).
sup_check_abort_or_reset() {
  if [ -f "$SUPERVISOR_DIR/abort" ]; then
    log "!! supervisor abort requested - stopping for manual --resume"
    sup_log "abort requested at a safe point - stopping"
    graceful_shutdown
    exit 1
  fi
  if [ "${SUPERVISOR_RESET:-false}" = true ]; then
    log "[supervisor] RESET requested - saving state and exiting for relaunch"
    sup_log "RESET requested at a safe point - exiting for relaunch"
    graceful_shutdown
    exit 0
  fi
}

# --- process-tree helpers (Windows Git Bash) -----------------------------
# `ps -W` prints: PID PPID PGID WINPID TTY UID STIME COMMAND. For a process
# started with `exec` from a subshell, $1 (the msys PID) maps to the real
# Windows PID in column 4. On POSIX shells the pid is its own "native" pid.
native_pid() {   # $1 = msys/posix pid -> native pid used for tree-kill
  if [ "$PLATFORM_WIN" = 1 ]; then
    ps -W | awk -v p="$1" 'NR>1 && $1==p {print $4}'
  else
    echo "$1"
  fi
}

# Kill a process and its whole tree. Windows: `taskkill //F //T //PID`.
# POSIX: recursive kill of all descendants (via pgrep -P) then kill -9.
kill_tree_win() {   # $1 = native pid
  [ -n "$1" ] || return 0
  if [ "$PLATFORM_WIN" = 1 ]; then
    taskkill //F //T //PID "$1" >/dev/null 2>&1
  elif command -v pgrep >/dev/null 2>&1; then
    _ktw_recursive "$1"
  else
    kill -9 "$1" 2>/dev/null
  fi
}

_ktw_recursive() {   # $1 = pid; kills descendants depth-first, then the pid
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null); do
    _ktw_recursive "$c"
  done
  kill -9 "$p" 2>/dev/null
}

# Kill everything this driver spawned (and the driver itself). The driver's
# native pid is the root of every pi/opencode/winpty/subshell descendant, so a
# single /T kill reaps the whole tree. Used by the INT/TERM/HUP trap so that
# Ctrl+C / kill never strands orphaned agents or handout writers.
kill_own_tree() {
  local driver_win
  driver_win="$(native_pid "$$")"
  log "!! kill_own_tree (driver winpid=${driver_win:-?})"
  kill_tree_win "$driver_win"
}

# Graceful shutdown: persist state so a later --resume/--restore continues from
# the CURRENT step (never marking it done), tear down any running agent/handout
# writer, and exit non-zero. Triggered on model stalls (quota/rate-limit/
# blocked/queue overflow) and on Ctrl+C / kill. The model is NEVER swapped.
#
# In single-module mode this exits the process. In sequence mode it returns 1
# (the caller propagates so run_one_module can run its resume loop); GRACEFUL_
# SHUTDOWN_DONE tracks whether a real interruption happened vs a supervisor
# resume.
graceful_shutdown() {
  # Chat mode has its own shutdown path: no run_state.json / handouts exist;
  # the harness transcript is the recovery source and history.jsonl simply
  # lacks the interrupted turn (DP-CHAT §6, §11).
  if [ "${CHAT_ACTIVE:-false}" = true ]; then
    chat_graceful_shutdown
    return 0
  fi
  log "!! graceful shutdown: persisting state for --resume and tearing down processes"
  dbg "graceful_shutdown entered: stage=${STAGE:-none} step=${CURRENT_STEP:-} module=${MODULE:-} interrupted=$INTERRUPTED"
  dbg_dump_state "graceful-shutdown"
  # Guard against a very early signal (vars not yet set) under `set -u`.
  CURRENT_HANDOUT="${CURRENT_HANDOUT:-}"
  COMPLETED_CSV="${COMPLETED_CSV:-}"
  CURRENT_STEP="${CURRENT_STEP:-0}"
  STAGE="${STAGE:-none}"
  # Preserve the best available handover for the in-flight step. Prefer the live
  # handout_active.md (the agent's own, possibly updated, handover) over the
  # driver's snapshot.
  if [ -f "handout_active.md" ]; then
    local act
    act="$(cat "handout_active.md")"
    if [ -n "$act" ] && [ "$act" != "$CURRENT_HANDOUT" ]; then
      CURRENT_HANDOUT="$act"
      log "  preserving agent-maintained handout_active.md for resume"
    fi
  fi
  STAGE="interrupted"
  save_state
  if [ -n "${RUN_PID:-}" ] && kill -0 "$RUN_PID" 2>/dev/null; then
    log "  killing running agent (pid=$RUN_PID)"
    kill_tree_win "$(native_pid "$RUN_PID")"
    kill "$RUN_PID" 2>/dev/null
    wait "$RUN_PID" 2>/dev/null
  fi
  if [ -n "${WRITER_PID:-}" ] && kill -0 "$WRITER_PID" 2>/dev/null; then
    log "  killing handout writer (pid=$WRITER_PID)"
    kill_tree_win "$(native_pid "$WRITER_PID")"
    kill "$WRITER_PID" 2>/dev/null
    wait "$WRITER_PID" 2>/dev/null
  fi
  log "  run interrupted (stage=$STAGE, step=$CURRENT_STEP, completed=[$COMPLETED_CSV])."
  log "  resume later with: bash run_sweep.sh --prompts <file> --resume   (or --restore for a verify pass)"
  # Report the in-flight step as INTERRUPTED so the user always has a summary to
  # inspect even when a run does not finish cleanly.
  if [ -n "${STEP_START_S:-}" ] && [ -n "${STEP_AGENT_COUNT:-}" ] && [ "${STEP_AGENT_COUNT:-0}" -gt 0 ]; then
    elapsed=$(( $(now_s) - STEP_START_S ))
    write_step_summary "$CURRENT_STEP" "INTERRUPTED" "$elapsed"
    tokens="$(step_tokens)"; tokens_in="${tokens%%|*}"; cache_pct="$(printf '%s\n' "$tokens" | awk -F'|' '{print $5}')"
    record_step_row "$CURRENT_STEP" "INTERRUPTED" "$elapsed" "$STEP_AGENT_COUNT" "$tokens_in" "$cache_pct"
  fi
  GRACEFUL_SHUTDOWN_DONE=true
  # ---- DP-SUPERVISOR: Layer 1 triage + Layer 2 handoff (supervise mode) ----
  # Only step-level shutdowns (SUPERVISOR_ATTEND=true) are eligible; a human
  # Ctrl+C / kill (INT/TERM) or a self_check failure is NOT sent to the
  # supervisor. A transcript model error is `transient`. Anything else is
  # `needs_judgement` -> open the menu and let the supervisor fix + resume.
  if [ "$SUPERVISE" = true ] && [ "${SUPERVISOR_ATTEND:-false}" = true ]; then
    if [ "$(sup_classify)" = "needs_judgement" ]; then
      sup_log "${MODULE:-?} step ${CURRENT_STEP:-?} INTERRUPTED - verdict=needs_judgement (no transcript error, suspicious)"
      sup_attend "$CURRENT_STEP"
      # sup_attend returns only when the supervisor RESUMED the run.
      log "  [supervisor] run resumed - continuing from step $CURRENT_STEP"
      GRACEFUL_SHUTDOWN_DONE=false
      return 0
    else
      sup_log "${MODULE:-?} step ${CURRENT_STEP:-?} INTERRUPTED - verdict=transient (model error recorded in transcript)"
    fi
  fi
  print_final_summary
  if [ "$SEQUENCE_MODE" = true ]; then
    return 1
  fi
  exit 1
}

# After graceful_shutdown: 0 = supervisor resumed (keep going), 1 = interrupted.
after_gs() {
  if [ "$GRACEFUL_SHUTDOWN_DONE" = true ]; then
    GRACEFUL_SHUTDOWN_DONE=false
    return 1
  fi
  return 0
}

on_signal() {
  INTERRUPTED=true
  log "!! signal received -> graceful shutdown"
  dbg "SIGNAL received (INT/TERM/HUP) -> graceful shutdown (module=${MODULE:-} step=${CURRENT_STEP:-})"
  graceful_shutdown
  kill_own_tree
  exit 1
}

# Supervisor control signals (supervise mode only). The handlers only set flags;
# the flags are honoured at safe checkpoints (sup_attend / wait_if_paused /
# sup_check_abort_or_reset) so a file write is never torn mid-way.
sup_on_usr1() {   # PAUSE
  [ "$SUPERVISE" = true ] || return 0
  PAUSED=true
  echo "[supervisor] PAUSE received (SIGUSR1)"
  sup_log "PAUSE received (SIGUSR1)"
}

sup_on_usr2() {   # RESUME
  [ "$SUPERVISE" = true ] || return 0
  PAUSED=false
  SUPERVISOR_RESUME=true
  echo "[supervisor] RESUMED (SIGUSR2)"
  sup_log "RESUMED (SIGUSR2)"
}

sup_on_hup() {    # RESET (supervise) vs graceful shutdown (as before otherwise)
  if [ "$SUPERVISE" = true ]; then
    SUPERVISOR_RESET=true
    echo "[supervisor] RESET received (SIGHUP)"
    sup_log "RESET received (SIGHUP)"
  else
    on_signal
  fi
}

if [ "$SUPERVISE" = true ]; then
  trap 'on_signal' INT TERM
  trap 'sup_on_hup' HUP
  trap 'sup_on_usr1' USR1
  trap 'sup_on_usr2' USR2
else
  trap 'on_signal' INT TERM HUP
fi


# True when a transcript model error looks TRANSIENT (stream/connection drop,
# provider 5xx/overload) rather than structural (quota exhausted, auth,
# rate-limit window). Only transient errors are eligible for the same-session
# "continue" nudge; everything else goes straight to fresh-session retry.
is_transient_model_error() {
  local e="$1"
  case "$e" in
    *"Stream ended"*|*finish_reason*|*ECONNRESET*|*ECONNREFUSED*|*EPIPE*|*"socket hang up"*|*"Connection error"*|*"connection reset"*|*ETIMEDOUT*|*overloaded*|*UNAVAILABLE*|*502*|*503*|*504*)
      return 0 ;;
    *) return 1 ;;
  esac
}

# Number of continue-nudges used inside the current rolling window (log display).
continue_nudge_window_used() {
  set -- ${CONTINUE_NUDGE_TS:-}
  echo "$#"
}

# Try to consume one continue-nudge slot. Allowed while fewer than
# MAX_CONTINUE_NUDGES sends happened within the last CONTINUE_NUDGE_WINDOW_S
# seconds AND the absolute per-context-window total CONTINUE_MAX_TOTAL is not
# reached. Records the send on success. Returns 0=allowed, 1=budget exhausted.
continue_nudge_try() {
  local now t keep=""
  now="$(now_s)"
  for t in ${CONTINUE_NUDGE_TS:-}; do
    [ $(( now - t )) -lt "$CONTINUE_NUDGE_WINDOW_S" ] && keep="$keep$t "
  done
  set -- $keep
  [ $# -lt "$MAX_CONTINUE_NUDGES" ] || return 1
  [ "${CONTINUE_NUDGES_TOTAL:-0}" -lt "$CONTINUE_MAX_TOTAL" ] || return 1
  CONTINUE_NUDGE_TS="$keep$now "
  CONTINUE_NUDGES_TOTAL=$(( ${CONTINUE_NUDGES_TOTAL:-0} + 1 ))
  return 0
}

# --- outage-tolerant wedge detection (see WEDGE_* knobs above) ---------------
# Reset per session/context-window, alongside prev_err_used.
wedge_reset() {
  WEDGE_CONSEC=0
  prev_err_used=""
}

# Record a model error at cumulative usage $1 and decide whether the session is
# wedged. Errors at DIFFERENT usage counts are real progress -> reset the
# streak. Returns 0 = keep nudging this session; 1 = wedged, give up.
# Sets WEDGE_CONSEC (1-based consecutive zero-progress error count).
wedge_record() {
  if [ -n "${prev_err_used:-}" ] && [ "$1" = "$prev_err_used" ]; then
    WEDGE_CONSEC=$(( ${WEDGE_CONSEC:-0} + 1 ))
  else
    WEDGE_CONSEC=1
  fi
  prev_err_used="$1"
  [ "$WEDGE_CONSEC" -lt "$WEDGE_MAX_CONSECUTIVE" ]
}

# Sleep before the retry that follows the $1-th consecutive zero-progress
# error: the Nth entry of WEDGE_BACKOFF_SCHEDULE (holds at the last entry if
# the streak outgrows the schedule).
wedge_backoff_sleep() {
  local n=1 b="" last=""
  for b in $WEDGE_BACKOFF_SCHEDULE; do
    last="$b"
    if [ "$n" -eq "$1" ]; then
      sleep "$b"
      return 0
    fi
    n=$(( n + 1 ))
  done
  sleep "${last:-30}"
}

# Retry-or-give-up policy for model/API failures. A session that ends in a model
# error, or that produced no work at all, is NEVER a completion. The step is
# retried with a fresh window after a short backoff; only after MAX_MODEL_FAILURES
# consecutive failures does the driver shut down for --resume. MODEL_FAILURES is
# per-step and is reset on any real progress (threshold recycle) or on a genuine
# completion.
retry_or_shutdown() {   # $1 = human-readable reason
  MODEL_FAILURES=$(( MODEL_FAILURES + 1 ))
  dbg "retry_or_shutdown: reason=\"$1\" failures=$MODEL_FAILURES max=$MAX_MODEL_FAILURES step=${CURRENT_STEP:-?}"
  if [ "$MODEL_FAILURES" -ge "$MAX_MODEL_FAILURES" ]; then
    log "!! ${MAX_MODEL_FAILURES} consecutive failed sessions for step ${CURRENT_STEP:-?} (${1}) -> graceful shutdown; resume later with --audit --resume"
    SUPERVISOR_ATTEND=true
    graceful_shutdown
    SUPERVISOR_ATTEND=false
    after_gs && { MODEL_FAILURES=0; return 0; } || return 1
  fi
  log "!! ${1} -> retry step ${CURRENT_STEP:-?} with a fresh session in ${MODEL_FAILURE_BACKOFF_S}s (attempt ${MODEL_FAILURES}/${MAX_MODEL_FAILURES})"
  sleep "$MODEL_FAILURE_BACKOFF_S"
}

# The running bash instance reads $0 lazily. If the script file is edited WHILE it
# runs, the still-unread tail can be re-read as invalid syntax and then die with a
# raw "syntax error near unexpected token" fault. Guard each step with a parse
# check so that case degrades to a graceful shutdown (+ --resume) instead.
self_check() {
  bash -n "$0" 2>/dev/null || {
    log "!! $0 on disk is no longer valid bash (was it edited while running?) -> graceful shutdown"
    dbg "self_check FAILED: $0 no longer valid bash"
    graceful_shutdown
    return 1
  }
  return 0
}


# Detect the model's context window (tokens) from the local model registry.
# `opencode models <provider> --verbose` prints, for every model, a line
# "<provider>/<id>" followed by that model's JSON; we take limit.context of the
# model we are about to run. Prints "" on any error (caller falls back).
model_context_window() {   # $1 = provider/id (e.g. opencode/deepseek-v4-flash-free)
  local provider id ctx
  provider="${1%%/*}"
  id="${1#*/}"
  if [ -z "$provider" ] || [ -z "$id" ]; then
    echo ""; return 0
  fi
  ctx="$(python3 - "$provider" "$id" <<'PY'
import sys, json, re, subprocess
provider, model_id = sys.argv[1], sys.argv[2]
out = subprocess.run(["opencode", "models", provider, "--verbose"],
                     capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20, stdin=subprocess.DEVNULL)
lines = out.stdout.splitlines()
i = 0
n = len(lines)
id_re = re.compile(r"^[\w.-]+/[\w.-]+$")
while i < n:
    if id_re.fullmatch(lines[i].strip()):
        j = i + 1
        while j < n and not id_re.fullmatch(lines[j].strip()):
            j += 1
        try:
            d = json.loads("\n".join(lines[i+1:j]))
        except Exception:
            d = None
        if d and d.get("id") == model_id:
            lim = d.get("limit") or {}
            print(lim.get("context", ""))
            break
        i = j
    else:
        i += 1
PY
)"
  echo "$ctx"
}

# Pi mode: context window straight from models.json model_profiles (the single
# source of model truth). Prints "" on any error (caller falls back).
pi_context_window() {   # $1 = provider/id
  [ -f "$ROLE_FILE" ] || { echo ""; return 0; }
  python3 - "$ROLE_FILE" "$1" <<'PY'
import sys, json
d = json.load(open(sys.argv[1], encoding="utf-8-sig"))
target = sys.argv[2]
for prof in (d.get("model_profiles") or {}).values():
    if (prof.get("provider") or "") + "/" + (prof.get("model") or "") == target:
        print(prof.get("context_window") or "")
        break
PY
}

# Resolve a --role NAME against models.json: roles.<NAME>.model_profile ->
# model_profiles.<profile>. Sets MODEL_NAME to "<provider>/<model>". When that
# profile declares context_window_handout it becomes the FIXED token count at
# which the watchdog stops the agent and triggers the progress-handout handover.
# If the profile has no context_window_handout but the role declares a kill_pct,
# KILL_PCT is adopted for the auto-adaptive threshold instead. Dies on any error
# so a typo'd role never silently runs the default model.
resolve_role() {   # $1 = role name
  [ -f "$ROLE_FILE" ] || die "models file not found: $ROLE_FILE (required by --role)"
  local out provider model handout killpct poll_interval poll_tiers effort
  out="$(python3 - "$ROLE_FILE" "$1" <<'PY'
import sys, json
try:
    d = json.load(open(sys.argv[1], encoding="utf-8-sig"))
    r = d["roles"][sys.argv[2]]
    prof = d["model_profiles"][r["model_profile"]]
    print("%s|%s|%s|%s|%s|%s|%s" % (
        prof.get("provider", "opencode"),
        prof.get("model", ""),
        prof.get("context_window_handout", ""),
        r.get("kill_pct", ""),
        prof.get("poll_interval", ""),
        json.dumps(prof.get("poll_tiers") or []),
        prof.get("effort", ""),
    ))
except Exception:
    sys.exit(1)
PY
)" || die "role '$1' not found in $ROLE_FILE (check roles.<name>.model_profile maps to a defined model_profiles entry)"
  IFS='|' read -r provider model handout killpct poll_interval poll_tiers effort <<<"$out"
  [ -n "$provider" ] && [ -n "$model" ] \
    || die "role '$1' resolved to an incomplete model_profile in $ROLE_FILE (no provider/model)"
  MODEL_NAME="$provider/$model"
  EFFORT="$effort"
  if [ -n "$handout" ]; then
    KILL_AT="$handout"
    KILL_MODE="fixed"
    log " role '$1' -> model $MODEL_NAME (effort=${effort:-default}), handout trigger at $handout tokens"
  else
    log " role '$1' -> model $MODEL_NAME (effort=${effort:-default}) (no context_window_handout -> adaptive threshold)"
    [ -n "$killpct" ] && KILL_PCT="$killpct"
  fi
  # Per-model_profile adaptive-poll tuning (models.json model_profiles.<name>):
  #   poll_interval N        -> base poll seconds (used in compact mode / fallback)
  #   poll_tiers [[U,S],..]  -> absolute token boundaries; poll every S seconds while
  #                             usage <= U. Last tier uses until=-1 for "no upper bound".
  #                             Overrides the legacy <30%/30-70%/>=70% tiers entirely.
  if [ -n "$poll_interval" ] && [ "$POLL_GIVEN" != true ]; then
    POLL_EVERY_S="$poll_interval"
    POLL_TOP_S=$(( POLL_EVERY_S / 3 )); [ "$POLL_TOP_S" -lt 1 ] && POLL_TOP_S=1
    POLL_LOW_S=$(( POLL_EVERY_S * 3 ))
  fi
  POLL_TIERS_SPEC="$poll_tiers"
  if [ -n "$POLL_TIERS_SPEC" ]; then
    log " role '$1' poll tiers: ${POLL_TIERS_SPEC} tokens->seconds (base ${POLL_EVERY_S}s)"
  elif [ "$POLL_GIVEN" = true ]; then
    log " role '$1' no poll_tiers in profile; using --poll ${POLL_EVERY_S}s % tiers"
  fi
}

# Resolve the kill threshold. By default stop the agent at KILL_PCT% of the
# model's real context window (so the handout pass always has headroom). With a
# FIXED threshold (--role context_window_handout or --limit N) the poll tiers
# and the usage% display are relative to the effective kill point so the
# crossing is caught quickly instead of against the model's full window.
# In KILL_MODE=compact the threshold is logged but not used for recycling (only
# an explicit --limit is enforced as a hard ceiling by the poll loop).
resolve_kill_threshold() {
  local win=""
  if [ "$HARNESS" = "pi" ]; then
    win="$(pi_context_window "$MODEL_NAME")"
    if [ -z "$win" ] && [ -z "${PI_TEST_CMD:-}" ] && command -v pi >/dev/null 2>&1; then
      win="$(pi --list-models "$MODEL_NAME" 2>/dev/null | python3 -c '
import sys, json
data = sys.stdin.read()
try:
    d = json.loads(data)
except Exception:
    d = None
target = sys.argv[1] if len(sys.argv) > 1 else ""
if isinstance(d, list):
    for m in d:
        if not isinstance(m, dict):
            continue
        pid = (m.get("provider") or "") + "/" + (m.get("id") or "")
        if pid != target and m.get("id") != target:
            continue
        for k in ("contextWindow", "context_window"):
            if isinstance(m.get(k), int):
                print(m.get(k)); break
        else:
            lim = m.get("limit") or m.get("context")
            if isinstance(lim, dict) and isinstance(lim.get("context"), int):
                print(lim.get("context"))
        break
' "$MODEL_NAME" 2>/dev/null || true)"
    fi
  else
    win="$(model_context_window "$MODEL_NAME")"
  fi
  WINDOW_TOTAL=""
  if [ -n "$win" ] && [ "$win" -ge 1 ] 2>/dev/null; then
    WINDOW_TOTAL="$win"
  fi
  if [ -n "$KILL_AT" ]; then
    log " kill threshold FIXED at ${KILL_AT} tokens (model context window detected: ${win:-unknown})"
    WINDOW_TOTAL="$KILL_AT"
    TIER30=$(( KILL_AT * 30 / 100 ))
    TIER70=$(( KILL_AT * 70 / 100 ))
  elif [ -n "$WINDOW_TOTAL" ]; then
    KILL_AT=$(( WINDOW_TOTAL * KILL_PCT / 100 ))
    TIER30=$(( WINDOW_TOTAL * 30 / 100 ))
    TIER70=$(( WINDOW_TOTAL * 70 / 100 ))
  else
    KILL_AT="$FALLBACK_KILL_AT"
    WINDOW_TOTAL="$KILL_AT"
    TIER30=$(( KILL_AT * 30 / 100 ))
    TIER70=$(( KILL_AT * 70 / 100 ))
    log " WARN: could not detect context window for $MODEL_NAME; kill at fallback ${KILL_AT} tokens"
  fi
  log " effective window: ${WINDOW_TOTAL} tokens -> kill at ${KILL_AT} tokens"
  if [ "$KILL_MODE" = "compact" ]; then
    log " KILL_MODE=compact: no usage-based recycle (Pi compacts); --limit ${HARD_LIMIT:-off} is the only hard ceiling"
  elif [ -n "$POLL_TIERS_SPEC" ]; then
    log " adaptive poll (per-profile tiers): $POLL_TIERS_SPEC tokens->seconds"
  else
    log " adaptive poll: <30% every ${POLL_LOW_S}s | 30-70% every ${POLL_EVERY_S}s | >=70% every ${POLL_TOP_S}s"
  fi
}

# --- transcript helpers: OpenCode implementations (verbatim, renamed) -------
# These are the OpenCode-only parsers. Pi mode uses the *_pi parsers below.
# All parsers are tolerant of partial/broken input (they print "" on error).

# Bounded opencode CLI call. A wedged CLI - e.g. opencode startup housekeeping
# stuck on a multi-GB local DB / a stale snapshot git index.lock (observed: the
# whole session-discovery loop blocked forever on a frozen `opencode session
# list`) - must NEVER hang the driver. `timeout` is present in Git Bash; on
# expiry it returns 124 and the opencode_* parsers degrade to "" (tolerant),
# so the driver takes its normal crash-resilience path instead of stalling.
# OC_CLI_TIMEOUT_S tunes it (default 20s).
OC_CLI_TIMEOUT_S="${OC_CLI_TIMEOUT_S:-20}"
oc_timeout() {   # oc_timeout <opencode args...>
  # stdin is ALWAYS /dev/null: a backgrounded CLI must never inherit the driver's
  # terminal TTY. On Windows, opencode with a TTY on stdin + redirected stdout
  # wedges in its startup housekeeping (observed: `opencode run` froze in
  # cleanup and the session-discovery `opencode session list` hung forever, while
  # the same commands launched with stdin=/dev/null work every time).
  if command -v timeout >/dev/null 2>&1; then
    timeout "$OC_CLI_TIMEOUT_S" "$@" < /dev/null
  else
    "$@" < /dev/null
  fi
}

opencode_usage_tokens() {   # $1 = session id -> cumulative tokens, "" on error
  oc_timeout opencode export "$1" 2>/dev/null \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["info"]["tokens"]["input"])' \
    2>/dev/null || true
}

# $1 = session id -> "cacheRead|cacheWrite|hit_pct", "" on error (OpenCode mode).
# OpenCode records per-message info.tokens.cache.{read,write}; sum over assistant
# messages and use the SAME hit formula as Pi (cacheRead/(input+cacheRead)) so the
# Pi-vs-OpenCode A/B is apples-to-apples.
opencode_session_cache() {
  oc_timeout opencode export "$1" 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit()
tin = cr = cw = 0
for m in d.get("messages", []):
    inf = m.get("info") or {}
    if inf.get("role") != "assistant":
        continue
    t = inf.get("tokens") or {}
    tin += int(t.get("input") or 0)
    cache = t.get("cache") or {}
    cr += int(cache.get("read") or 0)
    cw += int(cache.get("write") or 0)
hit = int(round(cr * 100.0 / (tin + cr))) if (tin + cr) > 0 else 0
print("%d|%d|%d" % (cr, cw, hit))' 2>/dev/null || true
}

# Derive, from a session's transcript, a compact summary of what that window
# actually did (files written/edited, test/lint commands run, files read, its
# last words). This is DETERMINISTIC - it does not depend on the model choosing
# to write a handout - so a failed handout writer never leaves the recycle
# restarting from the original spec. Prints "" on any error.
opencode_session_activity() {   # $1 = session id
  oc_timeout opencode export "$1" 2>/dev/null | python3 -c '
import sys, json, os
try:
    d = json.load(sys.stdin)
    msgs = d.get("messages", [])
except Exception:
    msgs = []
wrote = []
cmds = []
reads = 0
last_text = None
for m in msgs:
    role = (m.get("info") or {}).get("role")
    for p in m.get("parts", []):
        if p.get("type") != "tool":
            if role == "assistant" and p.get("type") == "text" and p.get("text", "").strip():
                last_text = p.get("text", "").strip().replace("\n", " ")[:250]
            continue
        tool = p.get("tool")
        inp = (p.get("state") or {}).get("input") or {}
        fp = inp.get("filePath") or ""
        cmd = inp.get("command") or ""
        if tool in ("write", "edit", "patch") and fp:
            b = os.path.basename(fp)
            if b in ("handout.md", "handout_active.md"):
                continue
            wrote.append(b if b else fp)
        elif tool == "bash" and cmd:
            c = " ".join(cmd.split())
            if any(k in c for k in ("pytest", "mypy", "ruff", "importlinter", "lint", "uv", "git", "python", "npm", "tsc")):
                cmds.append(c[:140])
        elif tool in ("read", "grep") and fp:
            reads += 1
out = []
if wrote:
    out.append("- Files written/edited this window: " + ", ".join(sorted(set(wrote))[:15]))
if reads:
    out.append("- Files read/searched this window: %d" % reads)
if cmds:
    out.append("- Commands run (tests/lint/verify):")
    for c in cmds[:12]:
        out.append("    - " + c)
if last_text:
    out.append("- Agent last said: " + last_text)
if out:
    print("## Window activity (derived from the interrupted session transcript)")
    print("\n".join(out))
' 2>/dev/null || true
}

# Print a non-empty description if the session's LAST assistant message recorded
# a model/API error. The transcript is the AUTHORITATIVE "did the run actually
# finish?" signal and must be checked before a step is marked complete.
opencode_session_errored() {   # $1 = session id
  oc_timeout opencode export "$1" 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit()
for m in reversed(d.get("messages", [])):
    inf = m.get("info") or {}
    if inf.get("role") != "assistant":
        continue
    err = inf.get("error") or {}
    if err:
        msg = (err.get("data") or {}).get("message") or err.get("name") or "model error"
        print(str(msg).strip().strip("\"").strip()[:300])
    sys.exit()
' 2>/dev/null || true
}

opencode_session_after() {  # $1 = after_ms, $2 = proj -> newest session id in project, "" on error
  oc_timeout opencode session list --format json 2>/dev/null \
    | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin) or []
except Exception:
    d = []
m = [x for x in d if x['created'] > $1 and x['projectId'] == '$2']
print(max(m, key=lambda x: x['created'])['id'] if m else '')" \
    2>/dev/null || true
}

opencode_detect_project() {  # project id of newest session matching the working directory
  # NOTE: session-list JSON is read from INSIDE python (subprocess), never passed
  # as an argv argument, because the list grows unboundedly and breaks the
  # Windows ~32K argv limit (E2BIG) once enough sessions have accumulated.
  python3 - "$WORKDIR" <<'PY'
import sys, json, os, subprocess
try:
    out = subprocess.run(["opencode", "session", "list", "--format", "json"],
                         capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20, stdin=subprocess.DEVNULL).stdout
    rows = json.loads(out or "[]") if out else []
except Exception:
    rows = []
target = sys.argv[1]
# Normalize the target path for comparison:
#   - MSYS style /c/Users/...  -> C:/Users/...
#   - WSL / POSIX /mnt/c/...   -> left as-is (normpath/normcase handle the rest)
if target.startswith("/"):
    parts = target.lstrip("/").split("/", 1)
    if len(parts[0]) == 1:
        target = parts[0].upper() + ":/" + (parts[1] if len(parts) > 1 else "")
m = [x for x in rows
     if os.path.normcase(os.path.normpath(x.get("directory", ""))) == os.path.normcase(os.path.normpath(target))]
print(max(m, key=lambda x: x["created"])["projectId"] if m else "")
PY
}

# --- transcript helpers: Pi implementations (session-file based) ------------
# Pi sessions are JSONL files on disk under $PI_SESSION_DIR/*/*.jsonl. Every
# parser is tolerant of partial/torn trailing lines (a hard taskkill can leave
# one) - each line is try/except'd and skipped if it is not valid JSON.

# $1 = session id -> session jsonl path, "" on error
pi_session_file() {
  python3 - "$PI_SESSION_DIR" "$1" <<'PY'
import sys, glob, json, os
d, sid = sys.argv[1], sys.argv[2]
for f in glob.glob(os.path.join(d, "*.jsonl")) + glob.glob(os.path.join(d, "*", "*.jsonl")):
    try:
        h = json.loads(open(f, encoding="utf-8-sig").readline())
    except Exception:
        continue
    if h.get("type") == "session" and h.get("id") == sid:
        print(f); break
PY
}

# $1 = session id -> cumulative input tokens, "" on error
pi_usage_tokens() {
  pi_session_file "$1" | python3 -c '
import sys, json
p = sys.stdin.read().strip()
if not p: sys.exit()
cum = 0
for line in open(p, encoding="utf-8"):
    try: e = json.loads(line)
    except Exception: continue
    if e.get("type") == "compaction":
        cum += int(e.get("tokensBefore") or 0); continue
    if e.get("type") != "message": continue
    m = e.get("message") or {}
    if m.get("role") == "assistant":
        cum += int((m.get("usage") or {}).get("input") or 0)
print(cum)' 2>/dev/null || true
}

# $1 = session id -> "1" if a tool call is currently in flight (an assistant
# message emitted a toolCall and no matching toolResult has landed yet), else "".
# Pi appends a message to the JSONL only when a round-trip COMPLETES: while a
# bash tool executes locally (e.g. a 30-min pytest) nothing is written to the
# session file or _run.log, so usage+log look frozen even though the agent is
# legitimately working. This is the discriminator the stall watchdog needs.
pi_session_tool_in_flight() {
  pi_session_file "$1" | python3 -c '
import sys, json
p = sys.stdin.read().strip()
if not p: sys.exit()
pending = set()
for line in open(p, encoding="utf-8"):
    try: e = json.loads(line)
    except Exception: continue
    if e.get("type") != "message": continue
    m = e.get("message") or {}
    if m.get("role") == "assistant":
        ids = [c["id"] for c in (m.get("content") or [])
               if c.get("type") == "toolCall" and c.get("id")]
        if ids:
            # Pi executes tools sequentially: a new toolCall SUPERSEDES any
            # earlier one whose result was never recorded (observed: a tool
            # result that pi drops, e.g. a superseded `write`). Tracking only
            # the current batch keeps a stale unresolved id from poisoning the
            # in-flight flag for the whole session and starting the tool-hang
            # watchdog timer at the WRONG tool (the real cause of premature
            # 3600s tool-hang kills).
            pending = set(ids)
    elif m.get("role") == "toolResult" and m.get("toolCallId"):
        pending.discard(m.get("toolCallId"))
print("1" if pending else "")' 2>/dev/null || true
}

# $1 = session id -> last assistant error message, "" if clean
pi_session_errored() {
  pi_session_file "$1" | python3 -c '
import sys, json
p = sys.stdin.read().strip()
if not p: sys.exit()
err = ""
for line in open(p, encoding="utf-8"):
    try: e = json.loads(line)
    except Exception: continue
    if e.get("type") != "message": continue
    m = e.get("message") or {}
    if m.get("role") != "assistant": continue
    # Only the LAST assistant message decides the session health: pi retries
    # transient provider errors internally, so an earlier stopReason=="error"
    # followed by successful messages means the session recovered and must NOT
    # be treated as errored (matches opencode_session_errored reverse scan).
    if m.get("stopReason") == "error":
        err = (m.get("errorMessage") or "model error")[:300]
    else:
        err = ""
print(err)' 2>/dev/null || true
}

# $1 = session id -> markdown summary of files/commands/reads, "" on error
pi_session_activity() {
  pi_session_file "$1" | python3 -c '
import sys, json, os
p = sys.stdin.read().strip()
if not p: sys.exit()
wrote, cmds, reads = [], [], 0
last_text = None
for line in open(p, encoding="utf-8"):
    try: e = json.loads(line)
    except Exception: continue
    m = e.get("message") if e.get("type") == "message" else None
    if not m: continue
    role = m.get("role")
    if role == "assistant":
        for c in m.get("content") or []:
            if c.get("type") == "toolCall":
                name = c.get("name") or ""
                args = c.get("arguments") or {}
                # Some Pi builds emit file paths under "path" (not "filePath"):
                # read/edit/write use {"path": ...}, so accept both keys.
                fp = args.get("filePath") or args.get("path") or ""
                if name in ("write", "edit", "patch") and fp:
                    b = os.path.basename(fp)
                    if b not in ("handout.md", "handout_active.md"):
                        wrote.append(b)
                elif name == "bash" and args.get("command"):
                    cmd = " ".join((args.get("command") or "").split())
                    if any(k in cmd for k in ("pytest","mypy","ruff","importlinter","lint","uv","git","python","npm","tsc")):
                        cmds.append(cmd[:140])
                elif name in ("read", "grep", "find", "ls") and fp:
                    reads += 1
            elif c.get("type") == "text" and (c.get("text") or "").strip():
                last_text = (c.get("text") or "").strip().replace("\n", " ")[:250]
    elif role == "bashExecution":
        cmd = " ".join((m.get("command") or "").split())
        if any(k in cmd for k in ("pytest","mypy","ruff","importlinter","lint","uv","git","python","npm","tsc")):
            cmds.append(cmd[:140])
out = []
if wrote: out.append("- Files written/edited this window: " + ", ".join(sorted(set(wrote))[:15]))
if reads: out.append("- Files read/searched this window: %d" % reads)
if cmds:
    out.append("- Commands run (tests/lint/verify):")
    for c in cmds[:12]: out.append("    - " + c)
if last_text: out.append("- Agent last said: " + last_text)
if out:
    print("## Window activity (derived from the interrupted session transcript)")
    print("\n".join(out))' 2>/dev/null || true
}

# $1 = session id -> "cacheRead|cacheWrite|hit_pct", "" on error (Pi mode).
# hit = cacheRead / (input + cacheRead) * 100, same formula as the token ledger.
pi_session_cache() {
  pi_session_file "$1" | python3 -c '
import sys, json
p = sys.stdin.read().strip()
if not p: sys.exit()
tin = cr = cw = 0
for line in open(p, encoding="utf-8"):
    try: e = json.loads(line)
    except Exception: continue
    if e.get("type") != "message": continue
    m = e.get("message") or {}
    if m.get("role") != "assistant": continue
    u = m.get("usage") or {}
    tin += int(u.get("input") or 0)
    cr += int(u.get("cacheRead") or 0)
    cw += int(u.get("cacheWrite") or 0)
hit = int(round(cr * 100.0 / (tin + cr))) if (tin + cr) > 0 else 0
print("%d|%d|%d" % (cr, cw, hit))' 2>/dev/null || true
}

# --- transcript dispatchers (Pi vs OpenCode) --------------------------------
usage_tokens() {   # $1 session id
  if [ "$HARNESS" = "pi" ]; then pi_usage_tokens "$1"; else opencode_usage_tokens "$1"; fi
}
session_errored() {   # $1 session id
  if [ "$HARNESS" = "pi" ]; then pi_session_errored "$1"; else opencode_session_errored "$1"; fi
}
session_activity() {  # $1 session id
  if [ "$HARNESS" = "pi" ]; then pi_session_activity "$1"; else opencode_session_activity "$1"; fi
}
# $1 session id -> "cacheRead|cacheWrite|hit_pct" (Pi or OpenCode), "" on error.
# Live cache readout for the watchdog log lines and the per-step ledger.
session_cache() {
  if [ "$HARNESS" = "pi" ]; then
    pi_session_cache "$1"
  elif [ "$HARNESS" = "opencode" ]; then
    opencode_session_cache "$1"
  fi
}

# --- debug: in-flight (unresolved) tool calls ---------------------------------
# $1 = session id -> the tool calls that were issued but whose result never
# landed in the transcript. This is the "which exact command did not reply"
# answer at a tool-hang / stall / interruption: the last unresolved call is the
# one the watchdog was waiting on. Prints one block per unresolved call.
pi_pending_tools() {   # $1 = session id
  pi_session_file "$1" | python3 -c '
import sys, json, os
p = sys.stdin.read().strip()
if not p: sys.exit()
pending = []
seen = set()
for line in open(p, encoding="utf-8"):
    try: e = json.loads(line)
    except Exception: continue
    if e.get("type") != "message": continue
    m = e.get("message") or {}
    if m.get("role") == "assistant":
        for c in m.get("content") or []:
            if c.get("type") == "toolCall" and c.get("id"):
                pending.append(c); seen.add(c["id"])
    elif m.get("role") == "toolResult" and m.get("toolCallId"):
        pending = [c for c in pending if c.get("id") != m.get("toolCallId")]
for c in pending:
    a = c.get("arguments") or {}
    cmd = a.get("command") or ""
    fp = a.get("filePath") or a.get("path") or ""
    extra = ""
    if cmd: extra = cmd.replace("\n", " ")[:900]
    elif fp: extra = fp
    else: extra = json.dumps(a, default=str)[:400]
    print("%s %s: %s" % (c.get("type", "toolCall"), c.get("name", "?"), extra))
' 2>/dev/null || true
}

opencode_pending_tools() {   # $1 = session id
  oc_timeout opencode export "$1" 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit()
pending = []
for m in d.get("messages", []):
    role = (m.get("info") or {}).get("role")
    if role == "assistant":
        for p in m.get("parts", []):
            if p.get("type") == "tool":
                st = p.get("state") or {}
                if st.get("status") in ("pending", "running", None):
                    inp = st.get("input") or {}
                    cmd = inp.get("command") or ""
                    fp = inp.get("filePath") or ""
                    extra = cmd.replace("\n", " ")[:900] if cmd else fp
                    print("%s %s: %s" % (p.get("tool", "tool"), st.get("status", "?"), extra))
    elif role == "tool":
        pass
' 2>/dev/null || true
}

session_pending_tools() {   # $1 = session id -> unresolved tool calls (debug)
  if [ "$HARNESS" = "pi" ]; then pi_pending_tools "$1"; else opencode_pending_tools "$1"; fi
}

# Full diagnostic bundle, dumped by graceful_shutdown / die / on_signal when
# debug is on. Every line goes through dbg -> $DEBUG_FILE only (never stdout).
dbg_dump_state() {   # $1 = trigger description
  [ "$DEBUG" = "1" ] || return 0
  dbg_sep "DEBUG STATE DUMP: $1"
  dbg "time: $(date '+%Y-%m-%d %H:%M:%S')"
  dbg "module=${MODULE:-} current_step=${CURRENT_STEP:-} stage=${STAGE:-} completed=[${COMPLETED_CSV:-}]"
  dbg "harness=$HARNESS kill_mode=$KILL_MODE mode=$MODE model=$MODEL_NAME role=${ROLE:-} effort=${EFFORT:-}"
  dbg "kill_at=${KILL_AT:-} window=${WINDOW_TOTAL:-} hard_limit=${HARD_LIMIT:-} session=${SID:-}"
  dbg "run_pid=${RUN_PID:-} writer_pid=${WRITER_PID:-} tool_since=${tool_since:-} stall_elapsed=$([ -n "${tool_since:-}" ] && echo $(( $(now_s) - tool_since )) || echo "-")"
  dbg "TOOL_STALL_TIMEOUT_S=$TOOL_STALL_TIMEOUT_S STALL_TIMEOUT_S=$STALL_TIMEOUT_S HANDOVER_TIMEOUT_S=$HANDOVER_TIMEOUT_S"
  dbg "--- run_state.json ---"
  cat "$STATE_FILE" 2>/dev/null | dbg_pipe
  dbg "--- sessions recorded for this step (.step_sids.tmp) ---"
  cat "$SID_LIST_FILE" 2>/dev/null | dbg_pipe
  if [ -n "${SID:-}" ]; then
    dbg "--- in-flight (never-resolved) tool calls in session $SID ---"
    local _pt; _pt="$(session_pending_tools "$SID")"
    if [ -n "$_pt" ]; then
      printf '%s\n' "$_pt" | dbg_pipe
    else
      dbg "(none detected in transcript - session JSONL may be torn after a hard kill)"
    fi
    dbg "--- transcript activity summary (last window) ---"
    session_activity "$SID" 2>/dev/null | dbg_pipe
    if [ "$HARNESS" = "pi" ]; then
      dbg "--- pi session file: $(pi_session_file "$SID" 2>/dev/null) ---"
    fi
  fi
  if [ -f "handout_active.md" ]; then
    dbg "--- handout_active.md (first 60 lines) ---"
    head -n 60 "handout_active.md" 2>/dev/null | dbg_pipe
  fi
  if [ -f "$HANDOVER_FILE" ]; then
    dbg "--- $HANDOVER_FILE (first 30 lines) ---"
    head -n 30 "$HANDOVER_FILE" 2>/dev/null | dbg_pipe
  fi
  dbg "--- _run.log tail (last 60 lines) ---"
  tail -n 60 "$WORKDIR/_run.log" 2>/dev/null | dbg_pipe
  if [ -f "$WORKDIR/_handout.log" ]; then
    dbg "--- _handout.log tail (last 20 lines) ---"
    tail -n 20 "$WORKDIR/_handout.log" 2>/dev/null | dbg_pipe
  fi
  dbg "--- live processes (python/pi/opencode/uv/pytest) ---"
  if [ "$PLATFORM_WIN" = 1 ]; then
    tasklist 2>/dev/null | grep -iE "pi\.exe|node\.exe|opencode|python|uv|pytest" | dbg_pipe
  else
    ps aux 2>/dev/null | grep -iE "pi|opencode|python|uv|pytest" | grep -v grep | dbg_pipe
  fi
  dbg_sep "end debug state dump: $1"
}

# ---------------------------------------------------------------------------
# IPC sentinel control plane + threshold-based tool telemetry
# (design_documents/draft_debugging_and_steering.md, §2 and §3)
# ---------------------------------------------------------------------------
# ipc_log/ipc_sep/ipc_pipe are the sentinel + telemetry writers. Unlike dbg()
# they write to $DEBUG_FILE UNCONDITIONALLY (even with DEBUG=0): they are the
# live steering/debugging surface this design adds, so a driver started without
# --debug still records slow-tool diagnostics and IPC events to the same
# .debug_run.log an analyst tails.
ipc_log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$DEBUG_FILE"; }
ipc_sep()  { printf '[%s] ===== %s =====\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$DEBUG_FILE"; }
ipc_pipe() { local _l; while IFS= read -r _l; do printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$_l" >>"$DEBUG_FILE"; done; }

# §3 Threshold-based tool logging + sub-process diagnostics. When a single
# in-flight tool call has been running for TOOL_LOG_S seconds, log the exact
# executed command/arguments to .debug_run.log; beyond TOOL_DIAG_S also append
# the active process-tree snapshot so an interactive prompt awaiting input can
# be diagnosed. Fires once per tool (markers reset when the tool clears).
tool_telemetry() {   # $1 = epoch when the current tool started
  local now el
  [ -n "$1" ] || return 0
  now="$(now_s)"; el=$(( now - $1 ))
  if [ "$el" -ge "$TOOL_DIAG_S" ] && [ "${tool_diag_logged:-0}" -eq 0 ]; then
    tool_diag_logged=1
    ipc_sep "SUB-PROCESS DIAGNOSTIC: tool in flight ${el}s (>= ${TOOL_DIAG_S}s)"
    if [ -n "${SID:-}" ]; then
      ipc_log "in-flight tool calls in session $SID:"
      session_pending_tools "$SID" 2>/dev/null | ipc_pipe
    fi
    ipc_log "active process tree (ps/tasklist):"
    if [ "$PLATFORM_WIN" = 1 ]; then
      tasklist 2>/dev/null | grep -iE "pi\.exe|node\.exe|opencode|python|uv|pytest" | ipc_pipe
    else
      ps aux 2>/dev/null | grep -iE "pi|opencode|python|uv|pytest" | grep -v grep | ipc_pipe
    fi
    ipc_sep "end sub-process diagnostic"
  elif [ "$el" -ge "$TOOL_LOG_S" ] && [ "${tool_logged:-0}" -eq 0 ]; then
    tool_logged=1
    ipc_sep "TOOL SLOW: tool in flight ${el}s (>= ${TOOL_LOG_S}s) - logging exact command"
    if [ -n "${SID:-}" ]; then
      session_pending_tools "$SID" 2>/dev/null | ipc_pipe
    fi
    ipc_sep "end tool-slow dump"
  fi
}

# §2 INSTRUCT: inject .intramessages/instructions.md into the live context. The
# agent maintains handout_active.md as its handover of record, so appending the
# new instructions there (and staging them for the next recycled handout) is the
# most reliable cross-harness injection point short of restarting the session.
inject_instructions() {
  local msg="$MSG_DIR/instructions.md" stamp
  [ -f "$msg" ] || { ipc_log "IPC INSTRUCT: $msg missing - nothing to inject"; return 0; }
  stamp="$(date '+%Y-%m-%d %H:%M:%S')"
  ipc_log "IPC INSTRUCT: injecting $msg into live handover context (stamp=$stamp)"
  if [ -f "handout_active.md" ]; then
    {
      echo ""
      echo "## Steering Instructions (injected $stamp)"
      echo "Follow these NEW instructions and fold them into the remaining work:"
      echo ""
      cat "$msg"
    } >>"handout_active.md"
    log "!! steering instructions injected into handout_active.md"
  else
    [ -f "$HANDOVER_FILE" ] && {
      {
        echo ""
        echo "## Steering Instructions (injected $stamp)"
        echo "Follow these NEW instructions and fold them into the remaining work:"
        echo ""
        cat "$msg"
      } >>"$HANDOVER_FILE"
    }
  fi
  # Always refresh the driver's in-memory handout so the injection survives any
  # later state save / handout materialization (e.g. a resume-partial step that
  # rewrites handout.md from CURRENT_HANDOUT).
  if [ -n "${CURRENT_HANDOUT:-}" ]; then
    CURRENT_HANDOUT="$CURRENT_HANDOUT

## Steering Instructions (injected $stamp)
Follow these NEW instructions and fold them into the remaining work:

$(cat "$msg")"
    if [ -f "$STATE_FILE" ]; then
      STAGE="${STAGE:-steered}"; save_state
    fi
  fi
  log "!! steering instructions folded into live handover context"
}

# §2 REPORT: emit status_report.md (human-readable live snapshot) + full debug
# dump at the next yield point. The transcript-derived sections show the current
# agent's in-flight / last activity without touching the running session.
write_status_report() {
  local f="$STATUS_REPORT_FILE"
  {
    echo "# Status Report - $(date '+%Y-%m-%d %H:%M:%S')"
    echo ""
    echo "- module: ${MODULE:-}"
    echo "- prompts: $PROMPTS_FILE"
    echo "- step: ${CURRENT_STEP:-}/${TOTAL:-}"
    echo "- stage: ${STAGE:-none}"
    echo "- completed: [${COMPLETED_CSV:-}]"
    echo "- harness: $HARNESS  kill_mode: $KILL_MODE  mode: $MODE"
    echo "- model: $MODEL_NAME"
    echo "- run_pid: ${RUN_PID:-}  writer_pid: ${WRITER_PID:-}  session: ${SID:-}"
    if [ -n "${STEP_START_S:-}" ]; then
      echo "- step elapsed: $(fmt_dur "$(( $(now_s) - STEP_START_S ))")"
    fi
    echo ""
    if [ -n "${SID:-}" ]; then
      echo "## Live usage"
      echo "- input tokens: $(usage_tokens "$SID" 2>/dev/null)"
      echo ""
      echo "## In-flight (never-resolved) tool calls"
      session_pending_tools "$SID" 2>/dev/null
      echo ""
      echo "## Last window activity (derived from the session transcript)"
      session_activity "$SID" 2>/dev/null
      echo ""
    fi
    echo "## Steered from: $CONTROL_DIR (drop DEBUG / REPORT / INSTRUCT / PAUSE / INTERRUPT)"
  } >"$f"
  log " status report written: $f"
  ipc_log "IPC REPORT: wrote $f"
}

# §2 INTERRUPT: soft-interrupt a stuck agent sub-process. SIGINT lets the CLI
# (and the Worker-AI) write failure diagnostics and pivot instead of being
# taskkill'ed -F; only when the process ignores the signal do we escalate to the
# hard tree kill so the driver can never stay stuck behind it.
soft_interrupt_agent() {
  local waited=0
  if [ -z "${RUN_PID:-}" ]; then
    ipc_log "IPC INTERRUPT: no RUN_PID set - nothing to interrupt"
    return 0
  fi
  if ! kill -0 "$RUN_PID" 2>/dev/null; then
    ipc_log "IPC INTERRUPT: agent pid=$RUN_PID not alive - nothing to interrupt"
    return 0
  fi
  ipc_log "IPC INTERRUPT: soft-interrupting agent pid=$RUN_PID (session=${SID:-})"
  log "!! IPC INTERRUPT sentinel -> sending SIGINT to agent pid=$RUN_PID"
  if [ -n "${SID:-}" ]; then
    ipc_log "in-flight tool calls before interrupt:"
    session_pending_tools "$SID" 2>/dev/null | ipc_pipe
  fi
  kill -INT "$RUN_PID" 2>/dev/null
  while kill -0 "$RUN_PID" 2>/dev/null && [ "$waited" -lt 15 ]; do
    sleep 1; waited=$(( waited + 1 ))
  done
  if kill -0 "$RUN_PID" 2>/dev/null; then
    ipc_log "IPC INTERRUPT: agent ignored SIGINT after ${waited}s -> escalating to hard tree kill"
    log "!! IPC agent ignored SIGINT -> escalating to hard tree kill (pid=$RUN_PID)"
    kill_tree_win "$(native_pid "$RUN_PID")"
    kill "$RUN_PID" 2>/dev/null
    wait "$RUN_PID" 2>/dev/null
  else
    ipc_log "IPC INTERRUPT: agent exited after SIGINT (${waited}s)"
    log "!! IPC agent interrupted (SIGINT) - failing gracefully back to the driver loop"
  fi
}

# §2 File Sentinel Control System: directory polling inside the main execution
# loop (design doc sample loop, adapted). Called at every poll iteration and at
# every safe checkpoint between steps. Never kills the driver.
check_ipc_sentinels() {
  # Dynamic Debug Toggle
  if [ -f "$CONTROL_DIR/DEBUG" ]; then
    DEBUG=1
    ipc_log "IPC DEBUG sentinel consumed -> dynamic DEBUG mode enabled"
    log "!! IPC DEBUG sentinel -> debug logging enabled on the fly (see $DEBUG_FILE)"
    rm -f "$CONTROL_DIR/DEBUG"
  fi

  # Dynamic state dump + status report (REPORT)
  if [ -f "$CONTROL_DIR/REPORT" ]; then
    ipc_log "IPC REPORT sentinel consumed -> writing status_report.md + debug dump"
    local saved_debug="$DEBUG"
    DEBUG=1
    dbg_dump_state "ipc-report"
    DEBUG="$saved_debug"
    write_status_report
    rm -f "$CONTROL_DIR/REPORT"
  fi

  # Dynamic instruction injection (INSTRUCT)
  if [ -f "$CONTROL_DIR/INSTRUCT" ] && [ -f "$MSG_DIR/instructions.md" ]; then
    inject_instructions
    ipc_log "IPC INSTRUCT sentinel consumed -> steering instructions injected"
    rm -f "$CONTROL_DIR/INSTRUCT"
  fi

  # Execution pause loop (PAUSE): freeze the driver loop; the agent keeps
  # running, so the user can inspect transcripts/processes safely.
  if [ -f "$CONTROL_DIR/PAUSE" ]; then
    ipc_log "IPC PAUSE sentinel detected -> driver loop paused"
    log "!! IPC PAUSE sentinel -> driver paused (agent keeps running). Remove $CONTROL_DIR/PAUSE to resume."
    while [ -f "$CONTROL_DIR/PAUSE" ]; do
      sleep 5
    done
    ipc_log "IPC PAUSE released -> driver loop resumed"
    log "!! IPC driver resumed."
  fi

  # Soft interrupt of a stuck sub-process (INTERRUPT)
  if [ -f "$CONTROL_DIR/INTERRUPT" ]; then
    soft_interrupt_agent
    rm -f "$CONTROL_DIR/INTERRUPT"
  fi
}

# Session discovery (Pi): scan _run.log for the first {"type":"session",...} line.
pi_sid_from_log() {
  python3 - "$WORKDIR/_run.log" <<'PY'
import sys, json
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    line = line.strip()
    if not line.startswith("{"): continue
    try:
        o = json.loads(line)
        if o.get("type") == "session" and o.get("id"):
            print(o["id"]); break
    except Exception:
        continue
PY
}

# Pi: newest session id in this workdir, "" on error
pi_newest_session() {
  python3 - "$PI_SESSION_DIR" "$WORKDIR" <<'PY'
import sys, glob, json, os
d, workdir = sys.argv[1], sys.argv[2]
best = None
for f in glob.glob(os.path.join(d, "*.jsonl")) + glob.glob(os.path.join(d, "*", "*.jsonl")):
    try:
        h = json.loads(open(f, encoding="utf-8-sig").readline())
    except Exception:
        continue
    if h.get("type") != "session" or not h.get("id"): continue
    if not h.get("cwd"): continue
    if os.path.normcase(os.path.normpath(h["cwd"])) != os.path.normcase(os.path.normpath(workdir)): continue
    if best is None or h.get("timestamp","") > best.get("timestamp",""):
        best = h
if best: print(best["id"])
PY
}

poll_interval_for() {   # $1 = usage tokens -> seconds until next poll
  if [ -n "$POLL_TIERS_SPEC" ]; then
    # Per-model_profile absolute token tiers: [[until_tokens,poll_s],...].
    # Pick the first tier with usage <= until; until==-1 = no upper bound.
    python3 - "$POLL_TIERS_SPEC" "$1" <<'PY'
import sys, json
tiers = json.loads(sys.argv[1])
u = int(sys.argv[2])
for until, poll in tiers:
    if until == -1 or u <= until:
        print(poll); break
PY
    return 0
  fi
  if   [ "$1" -ge "$TIER70" ]; then echo "$POLL_TOP_S"
  elif [ "$1" -ge "$TIER30" ]; then echo "$POLL_EVERY_S"
  else echo "$POLL_LOW_S"; fi
}

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
now_s()  { python3 -c 'import time;print(int(time.time()))'; }

# --- atomic state persistence -------------------------------------------------
# Fields: mode, module, current_step (1-based), completed (csv), stage, handout
save_state() {
  python3 - "$STATE_FILE" "$MODE" "$MODULE" "$CURRENT_STEP" "$COMPLETED_CSV" "$STAGE" "$CURRENT_HANDOUT" "$PROMPTS_FILE" <<'PY'
import sys, json, time, os
state, mode, module, step, completed, stage, handout, pfile = sys.argv[1:9]
st = {
  "mode": mode,
  "module": module,
  "prompts_file": os.path.basename(pfile),
  "current_step": int(step if step else 0),
  "completed": [int(x) for x in completed.split(",") if x],
  "stage": stage,
  "handout": handout,
  "updated_at": int(time.time()*1000),
}
tmp = state + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(st, f, indent=2, ensure_ascii=False)
os.replace(tmp, state)   # atomic
PY
}

load_state() {  # reads STATE_FILE, sets MODE, MODULE, CURRENT_STEP, COMPLETED_CSV, STAGE, CURRENT_HANDOUT
  [ -f "$STATE_FILE" ] || die "no state file ($STATE_FILE) to resume/restore"
  local s tmp
  tmp="${STATE_FILE}.handout.tmp"
  # Only ASCII scalar fields go over stdout. The multi-line handout may contain
  # arbitrary unicode (arrows, quotes, mojibake); it is written to a temp file in
  # UTF-8 and read back with cat, so it survives resume byte-for-byte and cannot
  # trip Windows' cp1252 stdout or be truncated by `read` (which takes one line).
  s="$(python3 - "$STATE_FILE" "$tmp" <<'PY' 2>/dev/null
import sys, json
state, tmp = sys.argv[1], sys.argv[2]
d = json.load(open(state, encoding="utf-8-sig"))
handout = d.get("handout", "")
with open(tmp, "w", encoding="utf-8") as f:
    f.write(handout if isinstance(handout, str) else "")
print("|".join(str(x) for x in [
    d.get("mode", "build"),
    d.get("module", ""),
    d.get("current_step", 0),
    ",".join(map(str, d.get("completed", []))),
    d.get("stage", ""),
]))
PY
)" || die "state file corrupted: $STATE_FILE"
  IFS='|' read -r MODE MODULE CURRENT_STEP COMPLETED_CSV STAGE <<<"$s"
  CURRENT_HANDOUT="$(cat "$tmp" 2>/dev/null)"
  rm -f "$tmp"
}

prompt_count() { python3 -c "import json;print(len(json.load(open('$PROMPTS_FILE',encoding='utf-8-sig'))['prompts']))"; }

module_id()    { python3 -c "import json;print(json.load(open('$PROMPTS_FILE',encoding='utf-8-sig'))['module'])"; }

# ---------------------------------------------------------------------------
# outer loop: render a fresh handout.md for one prompt (from prompts.json)
# ---------------------------------------------------------------------------
# Per-step role from prompts JSON ("" if absent). 1-based step index.
step_role() {  # $1 = 1-based step
  python3 - "$PROMPTS_FILE" "$1" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8-sig"))
idx = int(sys.argv[2]) - 1
prompts = data.get("prompts") or []
if idx < 0 or idx >= len(prompts):
    sys.exit(0)
role = (prompts[idx].get("role") or "").strip()
print(role)
PY
}

# Resolve ROLE / MODEL_NAME / kill threshold for the upcoming step.
# Priority: prompts[step].role > module fallback ($1) > --role / GLOBAL_ROLE > models.json default_role
apply_step_role() {  # $1 = 1-based step  $2 = module fallback role (may be "")
  local step="$1" fallback="$2" chosen
  chosen="$(step_role "$step")"
  [ -n "$chosen" ] || chosen="$fallback"
  if [ -z "$chosen" ]; then
    chosen="$(python3 -c "import json; print(json.load(open('$ROLE_FILE',encoding='utf-8-sig')).get('default_role','standard'))" 2>/dev/null || echo standard)"
  fi
  ROLE="$chosen"
  KILL_AT=""
  KILL_PCT=90
  WINDOW_TOTAL=""
  TIER30=0
  TIER70=0
  POLL_TIERS_SPEC=""
  POLL_EVERY_S="$GLOBAL_POLL_EVERY_S"
  POLL_TOP_S=$(( POLL_EVERY_S / 3 )); [ "$POLL_TOP_S" -lt 1 ] && POLL_TOP_S=1
  POLL_LOW_S=$(( POLL_EVERY_S * 3 ))
  resolve_role "$ROLE"
  if [ -n "$LIMIT_ARG" ]; then
    KILL_AT="$LIMIT_ARG"
  fi
  resolve_kill_threshold
  SUPERVISOR_MODEL="${SUPERVISOR_MODEL:-$MODEL_NAME}"
  export SUPERVISOR_MODEL
  log " step $step role='$ROLE' model=$MODEL_NAME"
}

render_handout() {  # $1 = 0-based prompt index
  local idx="$1"
  python3 - "$PROMPTS_FILE" "$idx" "$HANDOVER_FILE" <<'PY'
import sys, json
prompts_file, idx, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
with open(prompts_file, encoding="utf-8-sig") as f:
    data = json.load(f)
p = data["prompts"][idx]
module = data.get("module") or ""
module_name = data.get("module_name") or ""
design_plan = data.get("design_plan") or ""
title = p.get("title") or f"step {idx + 1}"
role = p.get("role") or ""
with open(out, "w", encoding="utf-8") as f:
    # Section titles must match the STATE HANDOVER note in inner_loop
    # (## 1. Completed Work / ## 3. Remaining Work).
    f.write("## 1. Completed Work\n")
    f.write(f"- {p['previous_implementation_summary']}\n\n")
    f.write("## 2. Current State\n")
    f.write(f"- Starting fresh session for {module}")
    if module_name:
        f.write(f" ({module_name})")
    f.write(f", step {idx + 1}: {title}\n")
    if role:
        f.write(f"- Assigned role for this step: {role}\n")
    if design_plan:
        f.write(f"- Authoritative design plan: {design_plan}\n")
    f.write("\n## 3. Remaining Work\n")
    f.write(f"{p['prompt_text']}\n\n")
    f.write("## 4. Key Constraints & Decisions\n")
    f.write("- Treat the design plan named above as authoritative; do not invent requirements.\n")
    f.write("- Prefer existing repo layout and conventions; do not rewrite unrelated modules.\n")
    f.write("- Run the verify commands named in Remaining Work before considering this step done.\n")
PY
  [ -f "$HANDOVER_FILE" ] || die "failed to render handout for step $((idx+1))"
  CURRENT_HANDOUT="$(cat "$HANDOVER_FILE")"
  log "handout written for step $((idx+1))"
}

# ---------------------------------------------------------------------------
# inner loop: drive ONE handout (the active work unit) to completion
#   PROMPT is set by the caller (FRESH_PROMPT | RESTORE_PROMPT | AUDIT_PROMPT).
# ---------------------------------------------------------------------------
inner_loop() {  # $1 = 1-based step number
  log "------------------------------------------"
  log " implementing step $1 (fresh context windows, adaptive watchdog)"
  log "------------------------------------------"
  MODEL_FAILURES=0
  DELIBERATE_STOP_AUDITS=0   # deliberate-stop guard: one audit re-dispatch per step
  DELIBERATE_AUDIT_PENDING=0
  while true; do
    wait_if_paused      # DP-SUPERVISOR: honour PAUSE before starting a new session
    # Escalation: after 2+ consecutive failed sessions on this step, earlier
    # attempts have very likely left PARTIAL edits on disk that the handout
    # does not mention (their stream died before they could update it).
    # Switch from the fresh prompt to the audit-style RESTORE prompt so each
    # retry first VERIFIES what already exists instead of blindly redoing it.
    if [ "$MODEL_FAILURES" -ge 2 ] && [ "$PROMPT" = "$FRESH_PROMPT" ]; then
      PROMPT="$RESTORE_PROMPT"
      log " switching to audit-style resume prompt (after $MODEL_FAILURES failed sessions on this step; partial edits may exist)"
    fi
    if [ -f "$HANDOVER_FILE" ]; then
      mv "$HANDOVER_FILE" "handout_active.md"
      CURRENT_HANDOUT="$(cat "handout_active.md")"
      STAGE="active"
      save_state
      log "active file: handout_active.md"
    fi

    # Ask the agent to MAINTAIN its handover as it works, so an interrupted
    # session always leaves behind real progress (done/remaining) that the next
    # window can resume from. Without this, a killed window only ever leaves the
    # original spec behind and every recycle re-verifies everything from zero.
    session_prompt="${PROMPT//\{HANDOVER\}/handout_active.md}
---
STATE HANDOVER: while working, KEEP 'handout_active.md' PRESENT on disk at all times and keep its '## 1. Completed Work' and '## 3. Remaining Work' sections current after every milestone (files written, tests run, requirements satisfied, what is still left). Match those exact section headings. If your context is cut off or this run is interrupted, the next session will read that file to take over exactly where you stopped. Do NOT delete it until the ENTIRE step is complete and verified.
WORK STYLE (MANDATORY - the provider terminates long-running generations mid-stream):
- One small tool call per reply; keep prose to 1-2 sentences.
- NEVER emit a large file in one Write: create it skeleton-first, then extend it with several small Edits.
- After EVERY completed edit or test run, IMMEDIATELY make one small Edit to handout_active.md moving that item from '## 3. Remaining Work' to '## 1. Completed Work'. Your stream can die at any moment; the handout is the only thing the next session inherits."
# 2026-08-25 CTAB-02 incident: an audit agent finished its step but never
# deleted the handout (no prompt told it to), so the driver misread the clean
# exit as a premature stop and its blind continue-nudge - aimed at a handout
# whose Remaining Work now enumerated every LATER step - triggered an hour-long
# unsupervised whole-module marathon. Every dispatch therefore carries an
# explicit finish criterion + scope discipline.
    session_prompt="${session_prompt}
FINISH PROTOCOL: when EVERY requirement of the CURRENT step in 'handout_active.md' is implemented AND verified (you personally ran the tests/commands in this session and they pass), DELETE 'handout_active.md' and end your turn. SCOPE DISCIPLINE: implement ONLY the work unit of the CURRENT step - do NOT start work belonging to LATER steps; each later step is dispatched separately and will re-verify anything you leave behind."
    # Deliberate-stop baseline: snapshot the handout as it stands at THIS
    # spawn. A later clean exit is only "deliberate" if the live handout
    # differs from this snapshot (the agent touched its handover).
    HANDOUT_BASELINE="$(cat "handout_active.md" 2>/dev/null || true)"
    log " spawn new session..."
    log "  (if Git Bash greys out, press Enter — or watch: tail -f $DRIVER_LOG)"
    mkdir -p "$PI_SESSION_DIR"
    start_ms="$(now_ms)"
    ( cd "$WORKDIR" && run_agent_cli "$session_prompt" ) \
      >"$WORKDIR/_run.log" 2>&1 < /dev/null &
    RUN_PID=$!

    SID=""
    SID_DISC_START="$(now_s)"
    # Loop is bounded by the WALL-CLOCK SESSION_DISCOVERY_TIMEOUT_S, not a
    # fixed iteration count: the old `seq 1 60` capped discovery at ~60s even
    # when SESSION_DISCOVERY_TIMEOUT_S was set higher (default 90).
    while [ $(( $(now_s) - SID_DISC_START )) -lt "$SESSION_DISCOVERY_TIMEOUT_S" ]; do
      if [ "$HARNESS" = "pi" ]; then
        SID="$(pi_sid_from_log)"
        [ -n "$SID" ] && break
      else
        SID="$(opencode_session_after "$start_ms" "$THIS_PROJECT")"
        [ -n "$SID" ] && break
      fi
      kill -0 "$RUN_PID" 2>/dev/null || break
      sleep 1
    done
    dbg "session discovery: start_ms=$start_ms elapsed=$(( $(now_s) - SID_DISC_START ))s sid=${SID:-none} run_pid=$RUN_PID"
    [ -n "$SID" ] || SID="$(pi_newest_session)"
    if [ -z "$SID" ]; then
      # The agent CLI never surfaced a session (wedged at startup - e.g. opencode
      # `run` frozen in its cleanup housekeeping on a bloated local DB). Never
      # churn for minutes: tear the wedged agent down via graceful_shutdown so the
      # step keeps its state and the sequence resume/retry loop takes over.
      log "!! could not discover a session id in ${SESSION_DISCOVERY_TIMEOUT_S}s (see _run.log) - agent CLI appears wedged at startup"
      dbg "SID discovery failed - dumping state (agent CLI wedged at startup)"
      dbg_dump_state "session-discovery-timeout"
      SUPERVISOR_ATTEND=true
      graceful_shutdown
      SUPERVISOR_ATTEND=false
      after_gs && continue || return 1
    fi
    log " session: $SID"
    dbg "session confirmed: $SID"
    record_step_agent "$SID"
    # Journal live-dot: point the module journal at this session so
    # chat_window.html shows its fresh indicator while the agent works.
    if [ -n "${JOURNAL_ID:-}" ]; then CHAT_DIR=".chat/$JOURNAL_ID"; chat_meta_op set-active "$SID" primary "$1"; fi

    crossed=false
    stalled=false
    DELIBERATE_AUDIT_PENDING=0   # set only by the deliberate-stop guard below; consumed post-loop
    CONTINUE_NUDGE_TS=""     # timestamps of recent continue-nudges (rolling rate window)
    CONTINUE_NUDGES_TOTAL=0  # absolute continue-nudge count for this context window
    wedge_reset              # wedge-streak + usage-at-last-drop, fresh per session
    last_used=""
    last_logsz=-1
    last_progress="$(now_s)"
    tool_since=""      # epoch when the current in-flight tool call started ("" = none)
    tool_logged=0      # 1 once the slow-tool telemetry (TOOL_LOG_S) has fired for this tool
    tool_diag_logged=0 # 1 once the sub-process diagnostic (TOOL_DIAG_S) has fired for this tool
    while :; do
      # Premature-stop guard ("continue" nudge). When the agent process ends on
      # its own with a CLEAN exit (no watchdog kill, no transcript error) but
      # handout_active.md is still present, the model most likely ended its
      # turn early mid-task. Cheapest correct remedy - exactly what a human
      # types interactively: send a short continue prompt INTO THE SAME SESSION
      # so it resumes where its generation stopped. Bounded by
      # MAX_CONTINUE_NUDGES per window; afterwards fall through to the normal
      # completion/recycle decision below.
      if ! kill -0 "$RUN_PID" 2>/dev/null; then
        # DELIBERATE-STOP guard: a clean exit that arrives together with an
        # UPDATED handout_active.md is a deliberate turn end, not a
        # mid-generation cut-off - the STATE HANDOVER protocol makes the
        # handout the last thing a finishing agent touches. Blindly nudging
        # such a session is exactly what turned the 2026-08-25 CTAB-02 step-1
        # audit into an hour-long unsupervised whole-module marathon: the nudge
        # said "complete the remaining work in handout_active.md" while the
        # freshly updated handout enumerated every later step. Remedy instead:
        # ONE audit re-dispatch in a fresh window (AUDIT_PROMPT + FINISH
        # PROTOCOL) - it must verify every requirement of THIS step against
        # the repo, run the tests, and delete handout_active.md, which routes
        # into normal completion detection below. Bounded to one attempt per
        # step; afterwards the ordinary nudge/recycle machinery applies.
        if [ "$crossed" = false ] && [ "$stalled" = false ] \
           && [ "$DELIBERATE_STOP_AUDITS" -lt 1 ] \
           && [ -f "handout_active.md" ] \
           && [ -z "$(session_errored "$SID")" ] \
           && [ "$(cat "handout_active.md" 2>/dev/null)" != "$HANDOUT_BASELINE" ]; then
          DELIBERATE_STOP_AUDITS=$(( DELIBERATE_STOP_AUDITS + 1 ))
          DELIBERATE_AUDIT_PENDING=1
          log "!! deliberate stop detected (clean exit, handout_active.md UPDATED during turn) -> scheduling one AUDIT re-dispatch instead of a blind 'continue' nudge"
          dbg "deliberate-stop guard: sid=$SID step=$1 baseline=${#HANDOUT_BASELINE}ch live=$(wc -c <"handout_active.md")B audits_used=$DELIBERATE_STOP_AUDITS"
          break   # -> post-loop: pending flag re-dispatches with AUDIT_PROMPT
        fi
        if [ "$crossed" = false ] && [ "$stalled" = false ] \
           && [ -f "handout_active.md" ] \
           && [ -z "$(session_errored "$SID")" ] \
           && continue_nudge_try; then
          log "!! premature stop detected (clean exit, handout_active.md still present) -> sending 'continue' to the SAME session ($(continue_nudge_window_used)/$MAX_CONTINUE_NUDGES per ${CONTINUE_NUDGE_WINDOW_S}s, total ${CONTINUE_NUDGES_TOTAL}/$CONTINUE_MAX_TOTAL)"
          dbg "premature-stop nudge: sid=$SID window_used=$(continue_nudge_window_used)/$MAX_CONTINUE_NUDGES total=${CONTINUE_NUDGES_TOTAL:-0}/$CONTINUE_MAX_TOTAL used=${used:-?}"
          sleep 2
          ( cd "$WORKDIR" && run_agent_cli --session "$SID" "$CONTINUE_PROMPT" ) \
            >"$WORKDIR/_run.log" 2>&1 < /dev/null &
          RUN_PID=$!
          last_used=""
          last_logsz=-1
          last_progress="$(now_s)"
          continue
        fi
        break
      fi
      # IPC sentinels: honour DEBUG/REPORT/INSTRUCT/PAUSE/INTERRUPT each poll.
      check_ipc_sentinels
      used="$(usage_tokens "$SID")"
      logsz="$(wc -c <"$WORKDIR/_run.log" 2>/dev/null || echo 0)"
      if [ -n "$used" ] && [ "$used" -ge 0 ] 2>/dev/null; then
        poll_s="$(poll_interval_for "$used")"
        pct=$(( used * 100 / WINDOW_TOTAL ))
      else
        poll_s="$POLL_EVERY_S"     # transient read error: fall back to mid tier
        pct="?"
      fi
      # Live cache readout (Pi only): cacheRead|cacheWrite|hit% for the log line.
      cache_log=""
      if [ "$HARNESS" = "pi" ]; then
        cache_stats="$(session_cache "$SID")"
        if [ -n "$cache_stats" ]; then
          cr="${cache_stats%%|*}"; rest="${cache_stats#*|}"; cw="${rest%%|*}"; hit="${rest#*|}"
          cache_log=" cacheRead=$cr cacheWrite=$cw hit=${hit}%"
        fi
      fi
      # Pi in-flight tool marker: while a tool executes locally, pi appends
      # nothing to the session JSONL or _run.log until the tool returns, so a
      # long local command (e.g. a 30-min pytest) must not be mistaken for a
      # stall. Compute it once per poll and reuse it in the log line and the
      # stall watchdog below.
      tool_in_flight=""
      if [ "$HARNESS" = "pi" ]; then
        [ "$(pi_session_tool_in_flight "$SID")" = "1" ] && tool_in_flight="1"
      fi
      tool_log=""; [ -n "$tool_in_flight" ] && tool_log=" [tool in flight]"
      if [ "$DEBUG" = "1" ]; then
        dbg "poll: used=${used:-?} logsz=$logsz pct=${pct:-?} poll_s=$poll_s tool_in_flight=${tool_in_flight:-0} tool_since=${tool_since:-} stall_elapsed=$([ -n "${tool_since:-}" ] && echo $(( $(now_s) - tool_since )) || echo "-")"
      fi
      if [ "$KILL_MODE" = "compact" ]; then
        log "  usage=${used:-?} (${pct}% of window, poll=${poll_s}s)$cache_log$tool_log [compact: no usage-based kill]"
      else
        log "  usage=${used:-?} (${pct}% of window, kill_at=$KILL_AT, poll=${poll_s}s)$cache_log$tool_log [budget: cumulative includes compactions]"
      fi
      # Model/API-level failure (quota exhausted, rate-limited, provider blocked,
      # queue overflow). Authoritative signal = the session transcript error
      # (opencode info.error / Pi stopReason=="error"). The console log is NEVER
      # scanned for error words: the agent legitimately prints them while reading.
      session_err="$(session_errored "$SID")"
      if [ -n "$session_err" ]; then
        dbg "MODEL ERROR detected in session $SID: $session_err -> stopping this session"
        log "!! session $SID recorded a model error: $session_err -> stopping session"
        # Evidence trail: how far did the dying session get? Handout size
        # shows whether it managed any checkpoint updates; the pending-tools
        # line shows what it was doing; the tail snippet goes to the debug log.
        log "   drop evidence: handout=$(wc -c <"handout_active.md" 2>/dev/null || echo missing)B pending=[$(session_pending_tools "$SID" 2>/dev/null | head -1)]"
        dbg "drop tail: $(tail -c 300 "$WORKDIR/_run.log" 2>/dev/null | tr '\n' ' ')"
        kill_tree_win "$(native_pid "$RUN_PID")"   # kill pi/opencode tree
        kill "$RUN_PID" 2>/dev/null                # reap the bash job
        wait "$RUN_PID" 2>/dev/null
        # Tiered response to TRANSIENT stream drops: before discarding all
        # accumulated context on a FRESH session, send a short continue prompt
        # INTO THE SAME SESSION so the model resumes its cut-off turn - what a
        # human types interactively. Rolling-rate budget (MAX_CONTINUE_NUDGES
        # per CONTINUE_NUDGE_WINDOW_S + CONTINUE_MAX_TOTAL total); non-transient
        # errors (quota, rate-limit, auth) skip the nudge and fall through to
        # retry_or_shutdown.
        #
        # Wedge detection (outage-tolerant): a re-error with ZERO token growth
        # since the previous drop is expected during a network outage - every
        # nudge re-uploads the same context and fails identically. Only declare
        # the session wedged after WEDGE_MAX_CONSECUTIVE consecutive
        # zero-progress errors, backing off between retries
        # (WEDGE_BACKOFF_SCHEDULE); continuing past real progress resets it.
        if ! wedge_record "${used:-0}"; then
          log "!! session $SID wedged after $WEDGE_CONSEC consecutive zero-progress errors (${used:-?}) -> skipping further continues"
          break
        fi
        if is_transient_model_error "$session_err" && continue_nudge_try; then
          log "   transient stream drop -> sending 'continue' to the SAME session ($(continue_nudge_window_used)/$MAX_CONTINUE_NUDGES per ${CONTINUE_NUDGE_WINDOW_S}s, total ${CONTINUE_NUDGES_TOTAL}/$CONTINUE_MAX_TOTAL)"
          wedge_backoff_sleep "$WEDGE_CONSEC"
          ( cd "$WORKDIR" && run_agent_cli --session "$SID" "$CONTINUE_PROMPT" ) \
            >"$WORKDIR/_run.log" 2>&1 < /dev/null &
          RUN_PID=$!
          last_used=""
          last_logsz=-1
          last_progress="$(now_s)"
          continue
        fi
        break
      fi
      # Threshold crossed -> stop agent and ask it to write a progress handout.
      if [ "$KILL_MODE" = "compact" ]; then
        # compact: only an explicit --limit is a hard economic ceiling.
        if [ -n "$HARD_LIMIT" ] && [ -n "$used" ] && [ "$used" -ge "$HARD_LIMIT" ]; then
          dbg "HARD LIMIT ($HARD_LIMIT) crossed at used=$used -> stopping agent (compact-mode ceiling)"
          log "!! --limit ($HARD_LIMIT) crossed -> stopping agent (compact-mode hard ceiling)"
          kill_tree_win "$(native_pid "$RUN_PID")"   # kill pi/opencode tree
          kill "$RUN_PID" 2>/dev/null                # reap the bash job
          wait "$RUN_PID" 2>/dev/null
          crossed=true
          MODEL_FAILURES=0                           # real progress: fresh retry budget
          break
        fi
      else
        if [ -n "$used" ] && [ "$used" -ge "$KILL_AT" ]; then
          dbg "KILL THRESHOLD crossed: used=$used >= kill_at=$KILL_AT -> stopping agent for handout"
          log "!! threshold crossed -> stopping agent"
          kill_tree_win "$(native_pid "$RUN_PID")"   # kill pi/opencode tree
          kill "$RUN_PID" 2>/dev/null                # reap the bash job
          wait "$RUN_PID" 2>/dev/null
          crossed=true
          MODEL_FAILURES=0                           # real progress: fresh retry budget
          break
        fi
      fi
      # Stall watchdog: the agent is alive but nothing observable changed (usage
      # tokens AND log size frozen). Covers "agent simply stops responding" on
      # quota/queue/block. STALL_TIMEOUT_S is generous enough that a long local
      # command (e.g. a 10-min pytest --timeout) is not mistaken for a stall.
      #
      # Pi nuance: while a tool call is executing (e.g. a 30-min pytest), pi
      # writes NOTHING to the session JSONL or _run.log until the tool returns,
      # so usage+log look frozen for the whole duration. That is legitimate
      # progress, not a stall. When the transcript shows an in-flight tool call
      # we therefore (a) never trip the usage+log stall, and (b) instead apply
      # the separate, much longer TOOL_STALL_TIMEOUT_S ceiling so a tool that is
      # genuinely hung (never returns) is still caught instead of running the
      # agent's own unbounded timeout forever.
      now="$(now_s)"
      if [ -n "$tool_in_flight" ]; then
        if [ -z "$tool_since" ]; then
          tool_since="$now"
          tool_logged=0
          tool_diag_logged=0
          # The watchdog's 3600s clock starts HERE. Log which tool actually
          # started the timer so a stale unresolved call (result never recorded)
          # can be told apart from the genuinely-running command.
          if [ "$DEBUG" = "1" ]; then
            dbg "TOOL-IN-FLIGHT timer started (tool_since=$tool_since, session=$SID). pending tool calls now:"
            session_pending_tools "$SID" 2>/dev/null | dbg_pipe
          fi
        elif [ "$used" != "$last_used" ] || [ "$logsz" != "$last_logsz" ]; then
          # usage/log ADVANCED while a tool is shown in flight => at least one
          # tool boundary was crossed since the last poll (an old tool returned
          # and a new one started) without a poll seeing the gap. Restart the
          # hang clock so a HEALTHY run that chains many fast tools back-to-back
          # is never mistaken for a single tool that is stuck, while a genuinely
          # hung tool (usage+log frozen for the whole 3600s) is still caught.
          tool_since="$now"
          tool_logged=0
          tool_diag_logged=0
          if [ "$DEBUG" = "1" ]; then
            dbg "TOOL-IN-FLIGHT advanced (usage/log moved) -> restarting tool-hang timer (session=$SID)"
          fi
        fi
        # Threshold-based tool telemetry (design doc §3): log the exact command
        # after TOOL_LOG_S and a process-tree snapshot after TOOL_DIAG_S.
        tool_telemetry "$tool_since"
        if [ $(( now - tool_since )) -ge "$TOOL_STALL_TIMEOUT_S" ]; then
          dbg "TOOL HANG: tool in flight for $(( now - tool_since ))s (>= $TOOL_STALL_TIMEOUT_S, timer started at tool_since=$tool_since) - session $SID"
          dbg "in-flight (never-resolved) tool calls in session $SID:"
          session_pending_tools "$SID" 2>/dev/null | dbg_pipe
          log "!! a tool call has been in flight for ${TOOL_STALL_TIMEOUT_S}s (agent alive) -> tool hang (never returned) -> graceful shutdown"
          stalled=true
          break
        fi
        last_used="$used"; last_logsz="$logsz"; last_progress="$now"
      else
        if [ -n "$tool_since" ] && [ "$DEBUG" = "1" ]; then
          dbg "TOOL-IN-FLIGHT cleared (timer had run $(( now - tool_since ))s, session=$SID)"
        fi
        tool_since=""
        tool_logged=0
        tool_diag_logged=0
        if [ "$used" != "$last_used" ] || [ "$logsz" != "$last_logsz" ]; then
          last_used="$used"; last_logsz="$logsz"; last_progress="$now"
        fi
        if [ $(( now - last_progress )) -ge "$STALL_TIMEOUT_S" ]; then
          dbg "STALL: no observable progress for $(( now - last_progress ))s (>= $STALL_TIMEOUT_S) - session $SID, last_used=$last_used last_logsz=$last_logsz"
          dbg "last tool calls in session $SID:"
          session_pending_tools "$SID" 2>/dev/null | dbg_pipe
          log "!! no observable progress for ${STALL_TIMEOUT_S}s (agent alive) -> model stall (quota/queue/blocked) -> graceful shutdown"
          stalled=true
          break
        fi
      fi
      sleep "$poll_s"
    done

    if $stalled; then
      dbg "stalled=true -> dumping state before graceful shutdown"
      dbg_dump_state "stall-or-tool-hang"
      SUPERVISOR_ATTEND=true
      graceful_shutdown
      SUPERVISOR_ATTEND=false
      # Only reached when the supervisor RESUMED the run -> retry the step with
      # a fresh window (the supervisor may have fixed the root cause already).
      after_gs && continue || return 1
    fi

    if ! $crossed; then
      # The agent process ended on its own. Distinguish a genuine completion
      # from a model/API failure that made the CLI exit: the latter must NOT
      # mark the step done. The AUTHORITATIVE signal is the transcript error.
      session_err="$(session_errored "$SID")"
      if [ -n "$session_err" ]; then
        dbg "session $SID ended on its own WITH a model error: $session_err"
        log "!! session $SID ended with a model error: $session_err"
        retry_or_shutdown "session ended with model error: $session_err" || return 1
        continue
      fi
      used_now="$(usage_tokens "$SID")"
      if [ -z "$(session_activity "$SID")" ] && { [ "$used_now" = "0" ] || [ -z "$used_now" ]; }; then
        dbg "session $SID exited without producing any work (used=$used_now)"
        log "!! session $SID exited without producing any work"
        retry_or_shutdown "session produced no work" || return 1
        continue
      fi
      # Deliberate-stop follow-through (see the guard inside the poll loop):
      # re-dispatch THIS step once with the audit prompt in a fresh window.
      # The auditor verifies what exists, finishes or repairs it, runs the
      # tests, and - per the FINISH PROTOCOL now present on every dispatch -
      # deletes handout_active.md, so normal completion detection applies.
      if [ "${DELIBERATE_AUDIT_PENDING:-0}" = 1 ]; then
        DELIBERATE_AUDIT_PENDING=0
        PROMPT="$AUDIT_PROMPT"
        log " deliberate stop -> re-dispatching step $1 with the AUDIT prompt (fresh window verifies every requirement, then deletes the handout)"
        dbg "deliberate-stop re-dispatch: step=$1 prompt=AUDIT_PROMPT sid=$SID"
        sleep 2
        continue
      fi
      # agent finished this step on its own (below threshold) -> step complete.
      # UNLESS the work unit is still on disk: handout_active.md must be gone
      # (STATE HANDOVER protocol). If it survived even after the continue-nudge
      # budget, do NOT mark the step complete - recycle with the live handout
      # so the next window audits what actually exists.
      if [ -f "handout_active.md" ]; then
        log "!! session $SID ended below threshold with handout_active.md still present (after ${CONTINUE_NUDGES_TOTAL:-0}/${CONTINUE_MAX_TOTAL} continue-nudges, ${MAX_CONTINUE_NUDGES}/${CONTINUE_NUDGE_WINDOW_S}s rate) -> recycling instead of marking step $1 complete"
        dbg "unfinished-step guard tripped: sid=$SID step=$1 -> crossed=true (handout recovery path)"
        crossed=true
      fi
      if [ "$crossed" = false ]; then
        dbg "step $1 complete: session $SID ended on its own below threshold (used=$used_now)"
        MODEL_FAILURES=0
        STAGE="step_done"
        CURRENT_STEP="$(($1))"
        COMPLETED_CSV="$(append_csv "$COMPLETED_CSV" "$1")"
        CURRENT_HANDOUT=""
        save_state
        rm -f "handout_active.md"
        log " step $1 complete. saved state."
        return 0
      fi
    fi

    # ---- recover a progress handout for the next window ----
    dbg "threshold crossed -> recovering a progress handout for the next window (step $1)"
    STAGE="writing_handout"
    save_state
    # Fast path: the STATE HANDOVER instruction makes the agent keep
    # handout_active.md current as it works. If it now differs from the original
    # snapshot (i.e. the killed window made progress before it was cut off), use
    # that live handover directly and skip the flaky resumed-session writer.
    if [ -f "handout_active.md" ] && [ "$(cat "handout_active.md")" != "$CURRENT_HANDOUT" ]; then
      log " live handout_active.md already updated by the agent -> skipping model writer"
      mv "handout_active.md" "$HANDOVER_FILE"
      CURRENT_HANDOUT="$(cat "$HANDOVER_FILE")"
      STAGE="recycle"
      save_state
      sleep 3
      log " progress handout written -> recycle"
      continue
    fi

    log " asking stopped session to write progress handout..."
    log "   (deadline ${HANDOVER_TIMEOUT_S}s, log: _handout.log)"
    # After a taskkill //F a brand-new instance opened ~2s later can hang;
    # give a brief grace period. Pi-mode bumps it to 8s so a killed Pi process
    # finishes appending its last JSONL entry (less torn-line risk).
    if [ "$HARNESS" = "pi" ]; then
      sleep 8
    else
      sleep "$STOP_SLEEP_S"
    fi
    # Deterministic backstop: snapshot what this window actually did from its
    # transcript (the grace sleep above lets the killed session settle). Used
    # only if the model writer below fails, so a recycle never has to restart
    # the step from the original spec.
    WINDOW_ACTIVITY="$(session_activity "$SID")"
    [ -n "$WINDOW_ACTIVITY" ] && log "   transcript snapshot: $(echo "$WINDOW_ACTIVITY" | grep -c '^') activity lines"
    writer_log="$WORKDIR/_handout.log"
    : >"$writer_log"
    ( run_agent_cli --session "$SID" \
      "The context window is nearly full. Write $HANDOVER_FILE in $WORKDIR containing: completed work, current state, remaining work, and key decisions. Then stop." \
      >"$writer_log" 2>&1 < /dev/null ) &
    WRITER_PID=$!
    record_step_writer
    log "   handout-writer pid=$WRITER_PID started $(date '+%H:%M:%S')"
    produced=false
    model_err=false
    for _sec in $(seq 1 "$HANDOVER_TIMEOUT_S"); do
      if [ -f "$HANDOVER_FILE" ]; then produced=true; break; fi
      # The writer sometimes updates the live handout_active.md instead of
      # handout.md (the STATE HANDOVER note wins). Treat that as produced too.
      if [ -f "handout_active.md" ] && [ "$(cat "handout_active.md")" != "$CURRENT_HANDOUT" ]; then
        produced=true; break
      fi
      # The writer's model is also down: recycling into the same dead model is
      # pointless, so bail out for --resume right away. Authoritative check = the
      # session transcript (the writer continues the same $SID).
      if [ -n "$(session_errored "$SID")" ]; then
        model_err=true; break
      fi
      if ! kill -0 "$WRITER_PID" 2>/dev/null; then break; fi
      if [ $(( _sec % 15 )) -eq 0 ]; then
        log "   ...waiting for handout ${_sec}s (writer alive, _handout.log=$([ -s "$writer_log" ] && echo "$(wc -c <"$writer_log")B" || echo empty))"
      fi
      sleep 1
    done

    if ! $produced; then
      if $model_err; then
        dbg "handout writer hit a model/API error (quota/rate-limit/blocked) -> graceful shutdown"
        log "!! handout writer hit a model/API error (quota/rate-limit/blocked) -> graceful shutdown"
        SUPERVISOR_ATTEND=true
        graceful_shutdown
        SUPERVISOR_ATTEND=false
        after_gs && continue || return 1
      fi
      # writer stalled or died without producing a handout: kill it and recover
      dbg "handout NOT produced within ${HANDOVER_TIMEOUT_S}s (writer_pid=$WRITER_PID) -> killing writer and falling back"
      log "!! handout not produced within ${HANDOVER_TIMEOUT_S}s -> killing handout writer"
      kill_tree_win "$(native_pid "$WRITER_PID")"
      kill "$WRITER_PID" 2>/dev/null
      wait "$WRITER_PID" 2>/dev/null
      if [ -s "$writer_log" ]; then
        log "!! _handout.log tail (${HANDOVER_TIMEOUT_S}s elapsed):"
        tail -n 5 "$writer_log" | sed 's/^/!!   /'
        dbg "_handout.log tail:"
        tail -n 5 "$writer_log" | dbg_pipe
      else
        log "!! _handout.log EMPTY -> writer stalled inside CLI init (known post-kill race)"
        dbg "_handout.log EMPTY -> writer stalled inside CLI init (known post-kill race)"
      fi
      # fallback: prefer the LIVE handout_active.md (which the agent has been
      # maintaining as it works, i.e. it now DIFFERS from the snapshot) over the
      # driver's stale snapshot. When even that is unchanged, inject the
      # deterministic transcript snapshot so the recycle resumes real progress.
      if [ -f "handout_active.md" ] && [ "$(cat "handout_active.md")" != "$CURRENT_HANDOUT" ]; then
        mv "handout_active.md" "$HANDOVER_FILE"
        log "!! reused live handout_active.md (agent's ongoing handover) as fallback"
      elif [ -n "$CURRENT_HANDOUT" ]; then
        {
          echo "# INTERRUPTED HANDOVER - the previous window was cut off before it could report."
          echo "# The requirements below were being worked on and may be PARTIALLY done."
          echo "# AUDIT the existing implementation against each requirement, then finish."
          if [ -n "$WINDOW_ACTIVITY" ]; then
            echo ""
            printf '%s\n' "$WINDOW_ACTIVITY"
          fi
          echo ""
          printf '%s\n' "$CURRENT_HANDOUT"
        } > "$HANDOVER_FILE"
        log "!! wrote fallback handout from transcript activity + saved state (recycle will re-verify)"
      fi
    else
      # produced -> the writer did its job; reap it so a lingering generation can
      # never keep burning tokens or contending for the session DB.
      log "   handout produced -> reaping handout writer"
      kill_tree_win "$(native_pid "$WRITER_PID")"
      kill "$WRITER_PID" 2>/dev/null
      wait "$WRITER_PID" 2>/dev/null
    fi

    # Normalize the writer's output: it may have produced handout.md directly,
    # or promoted the live handout_active.md (see the produced-detection above).
    if [ ! -f "$HANDOVER_FILE" ] && [ -f "handout_active.md" ] \
       && [ "$(cat "handout_active.md")" != "$CURRENT_HANDOUT" ]; then
      log " writer updated live handout_active.md -> promoting it to $HANDOVER_FILE"
      mv "handout_active.md" "$HANDOVER_FILE"
    fi

    if [ -f "$HANDOVER_FILE" ]; then
      CURRENT_HANDOUT="$(cat "$HANDOVER_FILE")"
      STAGE="recycle"
      save_state
      rm -f "handout_active.md"
      sleep 3
      log " progress handout written -> recycle"
    else
      die "progress handout not produced and no fallback content available; stopping."
    fi
  done
}

append_csv() { # $1 existing csv, $2 value
  local csv="$1" v="$2"
  if [ -n "$csv" ]; then
    case ",$csv," in *",$v,"*) echo "$csv" ;; *) echo "$csv,$v" ;; esac
  else
    echo "$v"
  fi
}

# ---------------------------------------------------------------------------
# per-step + whole-run reporting
# ---------------------------------------------------------------------------
# Every step accumulates the session ids it spawned (insiders: main agent runs -
# the "how many agents" answer - plus handout-writer runs) and, on completion or
# graceful shutdown, writes a rich human-readable summary file under SUMMARY_DIR.
# A final tail also prints a compact per-step table and the whole-run duration.
init_step_metrics() {
  STEP_AGENT_COUNT=0
  STEP_WRITER_COUNT=0
  STEP_START_S="$(now_s)"
  : >"$SID_LIST_FILE"
}

record_step_agent() {   # $1 = session id used as a main work agent
  echo "$1" >>"$SID_LIST_FILE"
  STEP_AGENT_COUNT=$(( STEP_AGENT_COUNT + 1 ))
}

record_step_writer() {   # a handout-writer run is "half" an agent
  STEP_WRITER_COUNT=$(( STEP_WRITER_COUNT + 1 ))
}

fmt_dur() {   # $1 seconds -> "Xm Ys"
  local s="$1"
  [ -z "$s" ] && s=0
  local m=$(( s / 60 )) r=$(( s % 60 ))
  [ "$m" -gt 0 ] && printf '%sm %ss' "$m" "$r" || printf '%ss' "$r"
}

# Per-step token ledger for the final summary: "input|cacheRead|cacheWrite|compactions|hit_pct|summarized".
# Pi reads the on-disk session JSONL; OpenCode reads `opencode export` transcripts.
step_tokens() {
  if [ "$HARNESS" = "pi" ]; then
    [ -f "$SID_LIST_FILE" ] || { echo "|||||"; return 0; }
    python3 - "$PI_SESSION_DIR" "$SID_LIST_FILE" <<'PY'
import sys, json, glob, os
d, sidfile = sys.argv[1], sys.argv[2]
sfiles = {}
for f in glob.glob(os.path.join(d, "*.jsonl")) + glob.glob(os.path.join(d, "*", "*.jsonl")):
    try:
        h = json.loads(open(f, encoding="utf-8-sig").readline())
    except Exception:
        continue
    if h.get("type") == "session" and h.get("id"):
        sfiles.setdefault(h["id"], f)
tin = tout = cr = cw = comp = summ = 0
sids = [l.strip() for l in open(sidfile, encoding="utf-8") if l.strip()]
for sid in sids:
    f = sfiles.get(sid)
    if not f: continue
    for line in open(f, encoding="utf-8"):
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") == "compaction":
            comp += 1; summ += int(e.get("tokensBefore") or 0); continue
        if e.get("type") != "message": continue
        m = e.get("message") or {}
        if m.get("role") != "assistant": continue
        u = m.get("usage") or {}
        tin += int(u.get("input") or 0)
        tout += int(u.get("output") or 0)
        cr += int(u.get("cacheRead") or 0)
        cw += int(u.get("cacheWrite") or 0)
hit = int(round(cr * 100.0 / (tin + cr))) if (tin + cr) > 0 else 0
print("%d|%d|%d|%d|%d|%d" % (tin, cr, cw, comp, hit, summ))
PY
  elif [ "$HARNESS" = "opencode" ]; then
    [ -f "$SID_LIST_FILE" ] || { echo "|||||"; return 0; }
    python3 - "$SID_LIST_FILE" <<'PY'
import sys, json, subprocess
sidfile = sys.argv[1]
tin = tout = cr = cw = comp = summ = 0
sids = [l.strip() for l in open(sidfile, encoding="utf-8") if l.strip()]
for sid in sids:
    try:
        raw = subprocess.run(["opencode", "export", sid], capture_output=True,
                             text=True, encoding="utf-8", errors="replace", timeout=20, stdin=subprocess.DEVNULL).stdout
        d = json.loads(raw)
    except Exception:
        continue
    for m in d.get("messages", []):
        inf = m.get("info") or {}
        if inf.get("role") != "assistant": continue
        t = inf.get("tokens") or {}
        tin += int(t.get("input") or 0)
        tout += int(t.get("output") or 0)
        cache = t.get("cache") or {}
        cr += int(cache.get("read") or 0)
        cw += int(cache.get("write") or 0)
hit = int(round(cr * 100.0 / (tin + cr))) if (tin + cr) > 0 else 0
print("%d|%d|%d|%d|%d|%d" % (tin, cr, cw, comp, hit, summ))
PY
  else
    echo "|||||"
  fi
}

# Write step_summary - $1 step, $2 status(SUCCESS/FAILED/INTERRUPTED), $3 elapsed_s.
# Aggregates each recorded session's transcript (files written/edited, test
# commands, model errors) into a markdown report. Pi mode reads the on-disk
# session JSONL, OpenCode reads `opencode export`; both produce the same
# ## Token ledger (input/output/cacheRead/cacheWrite, hit ratio) and
# ## Compactions sections so the two harnesses can be compared directly.
write_step_summary() {   # $1 step $2 status $3 elapsed_s
  local step="$1" status="$2" elapsed="$3"
  mkdir -p "$SUMMARY_DIR"
  local summary_file="$SUMMARY_DIR/step_summary_${MODULE}_${step}.md"
  python3 - "$step" "$status" "$elapsed" "$STEP_AGENT_COUNT" "$STEP_WRITER_COUNT" "$SID_LIST_FILE" "$summary_file" "$HARNESS" "$PI_SESSION_DIR" "$KILL_MODE" "$MODEL_NAME" "$MODULE" <<'PY'
import sys, json, subprocess, os, glob
step, status, elapsed, agents, writers = sys.argv[1:6]
sidfile, outfile = sys.argv[6], sys.argv[7]
harness = sys.argv[8] if len(sys.argv) > 8 else "opencode"
sdir = sys.argv[9] if len(sys.argv) > 9 else ""
kill_mode = sys.argv[10] if len(sys.argv) > 10 else ""
model_name = sys.argv[11] if len(sys.argv) > 11 else ""
module = sys.argv[12] if len(sys.argv) > 12 else ""
try:
    elapsed_f = round(float(elapsed), 1)
except Exception:
    elapsed_f = 0.0
mm, ss = int(elapsed_f)//60, int(elapsed_f)%60
sids = []
if os.path.exists(sidfile):
    sids = [l.strip() for l in open(sidfile, encoding="utf-8") if l.strip()]
created, modified, createdT, modifiedT = [], [], [], []
cmds, errors, reads = [], [], 0
last_text = None
tin = tout = tcr = tcw = 0
compactions = 0
summarized = 0

def collect_file(base, is_write, is_test):
    if is_write:
        (createdT if is_test else created).append(base)
    else:
        (modifiedT if is_test else modified).append(base)

def collect_cmd(cmd):
    if any(k in cmd for k in ("pytest", "test", "mypy", "ruff", "lint", "tsc", "npm", "uv", "python", "git")):
        cmds.append(" ".join(cmd.split())[:170])

if harness == "pi":
    sfiles = {}
    if sdir:
        for f in glob.glob(os.path.join(sdir, "*.jsonl")) + glob.glob(os.path.join(sdir, "*", "*.jsonl")):
            try:
                h = json.loads(open(f, encoding="utf-8-sig").readline())
            except Exception:
                continue
            if h.get("type") == "session" and h.get("id"):
                sfiles.setdefault(h["id"], f)
    for sid in sids:
        f = sfiles.get(sid)
        if not f:
            continue
        for line in open(f, encoding="utf-8"):
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("type") == "compaction":
                compactions += 1
                summarized += int(e.get("tokensBefore") or 0)
                continue
            if e.get("type") != "message":
                continue
            m = e.get("message") or {}
            role = m.get("role")
            if role == "assistant":
                if m.get("stopReason") == "error" or m.get("errorMessage"):
                    errors.append(str(m.get("errorMessage") or "model error")[:220])
                u = m.get("usage") or {}
                tin += int(u.get("input") or 0)
                tout += int(u.get("output") or 0)
                tcr += int(u.get("cacheRead") or 0)
                tcw += int(u.get("cacheWrite") or 0)
                for c in m.get("content") or []:
                    if c.get("type") != "toolCall":
                        if c.get("type") == "text" and (c.get("text") or "").strip():
                            last_text = c.get("text", "").strip().replace("\n", " ")[:220]
                        continue
                    name = c.get("name") or ""
                    args = c.get("arguments") or {}
                    # Pi emits file paths under "path" for read/edit/write (not "filePath").
                    fp = args.get("filePath") or args.get("path") or ""
                    cmd = args.get("command") or ""
                    if name in ("write", "edit", "patch") and fp:
                        base = os.path.basename(fp)
                        if base.lower() in ("handout.md", "handout_active.md"):
                            continue
                        collect_file(base, name == "write", "test" in base.lower())
                    elif name == "bash" and cmd:
                        collect_cmd(cmd)
                    elif name in ("read", "grep", "find", "ls") and fp:
                        reads += 1
            elif role == "bashExecution":
                collect_cmd(m.get("command") or "")
else:
    for sid in sids:
        try:
            raw = subprocess.run(["opencode", "export", sid], capture_output=True,
                                 text=True, encoding="utf-8", errors="replace", timeout=20, stdin=subprocess.DEVNULL).stdout
            d = json.loads(raw)
        except Exception:
            continue
        for m in d.get("messages", []):
            inf = m.get("info") or {}
            role = inf.get("role")
            if inf.get("error"):
                er = inf.get("error") or {}
                msg = (er.get("data") or {}).get("message") or er.get("name") or "model error"
                errors.append(str(msg).strip().strip('"')[:220])
            if role == "assistant":
                t = inf.get("tokens") or {}
                tin += int(t.get("input") or 0)
                tout += int(t.get("output") or 0)
                cache = t.get("cache") or {}
                tcr += int(cache.get("read") or 0)
                tcw += int(cache.get("write") or 0)
            for p in m.get("parts", []):
                if p.get("type") != "tool":
                    if role == "assistant" and p.get("type") == "text" and p.get("text", "").strip():
                        last_text = p.get("text", "").strip().replace("\n", " ")[:220]
                    continue
                tool = p.get("tool")
                inp = (p.get("state") or {}).get("input") or {}
                fp = inp.get("filePath") or ""
                cmd = inp.get("command") or ""
                if tool in ("write", "edit", "patch") and fp:
                    base = os.path.basename(fp)
                    if base.lower() in ("handout.md", "handout_active.md"):
                        continue
                    collect_file(base, tool == "write", "test" in base.lower())
                elif tool == "bash" and cmd:
                    collect_cmd(cmd)
                elif tool in ("read", "grep") and fp:
                    reads += 1

def slist(items, cap=18):
    uniq = []
    seen = set()
    for x in items:
        if x not in seen:
            seen.add(x); uniq.append(x)
        if len(uniq) >= cap:
            return uniq + ["..."]
    return uniq

L = []
L.append("# Step Summary - %s" % step)
L.append("")
L.append("## Status: %s" % status.upper())
L.append("")
L.append("## Run config")
L.append("- harness: %s" % (harness or "-"))
L.append("- kill_mode: %s" % (kill_mode or "-"))
L.append("- model: %s" % (model_name or "-"))
L.append("- module: %s" % (module or "-"))
L.append("")
if errors:
    L.append("**/\u26a0 Model/API errors detected (agent was retried):**")
    for e in errors[:8]:
        L.append("- " + e)
    L.append("")
L.append("Metrics: %d main agent session(s), %d handout-writer run(s), duration %d:%02d" % (int(agents), int(writers), mm, ss))
L.append("Files read/searched: %d" % reads)
L.append("")
L.append("## Files created")
L.append("(%d) %s" % (len(created), ", ".join(slist(sorted(set(created)))) if created else "none recorded"))
L.append("")
L.append("## Files modified")
L.append("(%d) %s" % (len(modified), ", ".join(slist(sorted(set(modified)))) if modified else "none recorded"))
L.append("")
L.append("## Tests created")
L.append("(%d) %s" % (len(createdT), ", ".join(slist(sorted(set(createdT)))) if createdT else "none recorded"))
L.append("")
L.append("## Tests modified")
L.append("(%d) %s" % (len(modifiedT), ", ".join(slist(sorted(set(modifiedT)))) if modifiedT else "none recorded"))
L.append("")
L.append("## Commands run (tests/lint/verify)")
if cmds:
    for c in cmds[:15]:
        L.append("  - " + c)
else:
    L.append("  - (none recorded)")
L.append("")
# Token ledger + compactions for BOTH harnesses so Pi-vs-OpenCode comparisons
# read the same summary format (OpenCode just never records compactions).
L.append("## Token ledger")
L.append("- input tokens: %d" % tin)
L.append("- output tokens: %d" % tout)
L.append("- cache read: %d" % tcr)
L.append("- cache write: %d" % tcw)
hit = int(round(tcr * 100.0 / (tin + tcr))) if (tin + tcr) > 0 else 0
L.append("- cache hit ratio: %d%%" % hit)
L.append("")
L.append("## Compactions")
L.append("%d compaction(s), summarized %d tokens" % (compactions, summarized))
L.append("")
L.append("## Notes")
L.append("- This step is recorded as %s by the driver." % status.upper())
if status.upper() == "SUCCESS":
    L.append("  The final session completed and exited on its own below the token "
             "threshold, i.e. the agent itself considered the work done and the "
             "validation/test task finished.")
else:
    L.append("  The step did NOT complete cleanly; read the detail sections above and "
             "the run logs (_run.log / _handout.log) before resuming.")
    L.append("  Resume later with: bash run_sweep.sh --prompts <file> --resume")
L.append("")
L.append("To override: the summary above is auto-derived from session transcripts; "
         "confirm pass/fail of tests by inspecting _run.log or re-running the listed "
         "commands yourself.")
data = "\n".join(L) + "\n"
os.makedirs(os.path.dirname(outfile) or ".", exist_ok=True)
with open(outfile, "w", encoding="utf-8") as f:
    f.write(data)
# Machine-readable sidecar for the driver's anti-skip gate: lets
# step_has_no_artifacts() decide objectively whether the step produced any
# repository artifact at all (see run_module_sweep).
metrics = {
    "module": module, "step": int(step), "status": status,
    "files_created": len(created), "files_modified": len(modified),
    "tests_created": len(createdT), "tests_modified": len(modifiedT),
    "cmds_run": len(cmds), "reads": reads, "errors": errors[:8],
    "compactions": compactions, "agents": int(agents), "writers": int(writers),
    "elapsed_s": elapsed_f,
    "tokens_in": tin,
}
try:
    with open(os.path.join(os.path.dirname(outfile) or ".",
                           ".step_metrics_%s_%s.json" % (module or "-", step)),
              "w", encoding="utf-8") as mf:
        json.dump(metrics, mf, ensure_ascii=False, indent=1)
except Exception:
    pass
print(data)
PY
  log " step summary written: $summary_file  (status=$status, agents=$STEP_AGENT_COUNT(+$STEP_WRITER_COUNT writer(s)), $elapsed s)"
}

# Anti-skip gate (DP-CTAB incident 2026-08-25): a step whose agent produced ZERO
# repository artifacts (no file created/modified, no test written) must not be
# accepted on the agent's word alone - "it already exists, nothing to do" is
# indistinguishable from a lazy/hallucinated skip at this point. Returns 0 when
# the step is artifact-free and needs a forced AUDIT pass.
step_has_no_artifacts() {   # $1 = step number
  local mf="$SUMMARY_DIR/.step_metrics_${MODULE}_${1}.json" n
  if [ -f "$mf" ]; then
    n="$(python3 -c "
import json
try:
    d = json.load(open(r'$mf', encoding='utf-8-sig'))
    print(int(d.get('files_created', 0)) + int(d.get('files_modified', 0))
          + int(d.get('tests_created', 0)) + int(d.get('tests_modified', 0)))
except Exception:
    print(-1)
")"
  else
    # legacy summaries predate the sidecar: fall back to the markdown markers
    n="$(grep -c '(0) none recorded' "$SUMMARY_DIR/step_summary_${MODULE}_${1}.md" 2>/dev/null || true)"
    if [ "$n" = "4" ]; then
      return 0
    fi
    return 1
  fi
  [ "$n" = "0" ]
}

# Append one row to the whole-run record table (step|status|elapsed|agents|tokens|cache_pct).
record_step_row() {   # $1 step $2 status $3 elapsed_s $4 agents $5 tokens $6 cache_pct (+ harness|kill_mode|module)
  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" "${5:-}" "${6:-}" "${HARNESS:-}" "${KILL_MODE:-}" "${MODULE:-}" >>"$STEP_RECORDS_FILE"
}

# CSV of steps already recorded SUCCESS for this module in the append-only step
# archive (.run_step_records.txt). Used to seed a fresh run so an interrupted /
# restarted module never re-implements steps that already succeeded. Rows look
# like: step|SUCCESS|elapsed|agents|tokens|cache|harness|kill_mode|module, but
# older rows lack the trailing module column (pre-module-column era). Legacy
# rows can only be attributed to the FIRST module in SEQUENCE (that is the only
# module that was run before the column existed); for every other module only
# modern rows with an exact module match count, so we never wrongly skip steps
# of a different module that happened to share step numbers.
archive_completed_steps() {   # $1 module
  local m="$1" s st rest csv="" nf legacy_owner=""
  [ -f "$STEP_RECORDS_FILE" ] || { echo ""; return 0; }
  if [ "${#SEQUENCE[@]}" -gt 0 ]; then
    legacy_owner="${SEQUENCE[0]%%:*}"
  fi
  while IFS='|' read -r s st rest; do
    # SUCCESS_AUDIT = accepted after the anti-skip gate forced a verify pass
    { [ "$st" = "SUCCESS" ] || [ "$st" = "SUCCESS_AUDIT" ]; } || continue
    nf="$(awk -F'|' -v r="$rest" 'BEGIN{print split(r, a, "|")}')"
    if [ "$nf" -ge 7 ]; then
      # modern row: last field is the module id
      [ "${rest##*|}" = "$m" ] || continue
    else
      # legacy row (no module column): only the first sequence module owns it
      [ -n "$legacy_owner" ] && [ "$legacy_owner" = "$m" ] || continue
    fi
    case ",$csv," in *",$s,"*) ;; *) csv="${csv:+$csv,}$s" ;; esac
  done <"$STEP_RECORDS_FILE"
  echo "$csv"
}

# Print the whole-run summary: one row per step, then the total elapsed time.
# The TOK column is cumulative input tokens (Pi mode); CACHE% is the cache-hit
# ratio of the step (Pi mode).
print_final_summary() {
  # All read-loop variables MUST be local: `module` (and the rest) would
  # otherwise clobber a caller's same-named variable via bash dynamic scoping,
  # e.g. run_one_module's local `module` -> mark_result gets an empty name and
  # .sequential_results.txt gets a corrupt `|DONE|` row (module never seen as
  # DONE -> the sequence re-runs it from step 1 forever).
  local total=0 line step status el agents tok cache harness kmode module
  log "========================================================================"
  log "                          FINAL RUN SUMMARY"
  log "========================================================================"
  if [ -f "$STEP_RECORDS_FILE" ]; then
    printf '%-6s %-12s %-10s %-10s %-12s %-7s %-8s %-6s %s\n' "STEP" "STATUS" "DURATION" "AGENTS(win)" "TOK" "CACHE%" "HARNESS" "KILL_MODE" "MODULE"
    printf '%-6s %-12s %-10s %-10s %-12s %-7s %-8s %-6s %s\n' "----" "------" "--------" "-------" "---" "------" "-------" "---------" "------"
    while IFS='|' read -r step status el agents tok cache harness kmode module; do
      [ -z "$step" ] && continue
      fmt="$(fmt_dur "$el")"
      cache="${cache:-}"
      [ -n "$cache" ] && cache="${cache}%"
      printf '%-6s %-12s %-10s %-10s %-12s %-7s %-8s %-6s %s\n' "$step" "$status" "$fmt" "${agents:-0}" "${tok:-0}" "${cache:--}" "${harness:--}" "${kmode:--}" "${module:--}"
      if [ "${el:-0}" -gt 0 ] 2>/dev/null; then total=$(( total + el )); fi
    done <"$STEP_RECORDS_FILE"
    log "------------------------------------------------------------------------"
    if [ -n "$RUN_START_S" ]; then
      log " Whole run elapsed: $(fmt_dur "$(( $(now_s) - RUN_START_S ))")"
    fi
    log " Per-step detail: $SUMMARY_DIR/step_summary_<MODULE>_<N>.md (see any INTERRUPTED/FAILED first)"
  else
    log " (no per-step records - run did not start a step)"
  fi
  log "========================================================================"
}

# ---------------------------------------------------------------------------
# sequence mode: helpers lifted from run_sequential.sh (in-process now)
# ---------------------------------------------------------------------------
is_done() {   # $1 module
  [ -f "$RESULTS_FILE" ] && grep -q "^$1|DONE" "$RESULTS_FILE"
}

mark_result() {   # $1 module  $2 status
  local m="$1" s="$2"
  # Guard against a corrupt (empty) module name: a `|DONE|` row without the
  # module id makes is_done() never match, so the sequence re-runs the module
  # from step 1 forever. Fall back to the prompts-derived module id, and refuse
  # to write a row we cannot attribute.
  if [ -z "$m" ]; then
    m="${MODULE:-}"
    if [ -n "$m" ]; then
      log "!! mark_result got an empty module name; using prompts-derived '$m' (status=$s)"
    else
      log "!! mark_result: no module name to record (status=$s); refusing to write corrupt row"
      return 1
    fi
  fi
  if [ -f "$RESULTS_FILE" ]; then
    sed -i "/^$m|/d" "$RESULTS_FILE" 2>/dev/null
  fi
  echo "$m|$s|$(date '+%Y-%m-%d %H:%M:%S')" >>"$RESULTS_FILE"
  # Journal: record the module verdict in its .chat/<module> conversation.
  if [ "${JOURNAL_ID:-}" = "$m" ]; then
    if [ "$s" = "DONE" ]; then
      journal_say "**Module \`$m\` complete.** Every step finished successfully."
    else
      journal_fail "module $m stopped with status $s (state saved)" "resume with --sequence --from $m"
    fi
  fi
}

should_skip() {   # $1 module  $2 prompts file
  [ "$FORCE" = true ] && return 1
  is_done "$1" && return 0
  # Belt-and-braces: even if .sequential_results.txt was corrupted (e.g. a
  # `|DONE|` row with an empty module name from the print_final_summary bug),
  # a module whose every step already has a SUCCESS record in the archive is
  # complete and must NOT be re-implemented.
  archive_module_complete "$1" "$2"
}

# 0 if every step 1..TOTAL of module $1 (prompts file $2) already has a SUCCESS
# record in the append-only step archive. TOTAL is read from the prompts file.
# Attribution matches archive_completed_steps (legacy pre-module-column rows are
# only credited to the first sequence module, which is the only one that ran in
# that era), so the two checks can never disagree.
archive_module_complete() {   # $1 module  $2 prompts file
  local m="$1" f="$2" total s csv
  [ -f "$f" ] || return 1
  total="$(python3 -c "import json;print(len(json.load(open('$f',encoding='utf-8-sig'))['prompts']))" 2>/dev/null)"
  [ -n "$total" ] && [ "$total" -ge 1 ] 2>/dev/null || return 1
  csv="$(archive_completed_steps "$m")"
  for ((s=1; s<=total; s++)); do
    case ",$csv," in *",$s,"*) ;; *) return 1 ;; esac
  done
  return 0
}

state_matches() {   # $1 module  -> 0 if run_state.json is for this module
  [ -f "run_state.json" ] || return 1
  local sm
  sm="$(python3 -c "import json;print(json.load(open('run_state.json',encoding='utf-8-sig')).get('module',''))" 2>/dev/null)"
  [ "$sm" = "$1" ]
}

seqlog() {   # sequence-level log line: stdout + .sequential_run.log
  echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# --- git per-module helpers (--git-init-add-per-module) -------------------
git_ensure_init_if_needed() {
  [ "$GIT_INIT_ADD_PER_MODULE" = true ] || return 0
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi
  log " [git] no repo detected -> git init -b main"
  if ! git init -b main >/dev/null 2>&1; then
    git init >/dev/null 2>&1 || { log " [git] git init failed"; return 0; }
    git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
  fi
  git config user.name "${GIT_USER_NAME:-chassis}" >/dev/null 2>&1 || true
  git config user.email "${GIT_USER_EMAIL:-chassis@local}" >/dev/null 2>&1 || true
  if [ -f "src/assembly/gitignore.template" ]; then
    cp "src/assembly/gitignore.template" ".gitignore" 2>/dev/null || true
  fi
  log " [git] initialized new repo on branch main"
}

git_commit_per_module() {  # $1 = module id
  [ "$GIT_INIT_ADD_PER_MODULE" = true ] || return 0
  local mod="$1"
  [ -n "$mod" ] || mod="${MODULE:-unknown}"
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log " [git] not a git repo, skipping commit for $mod"
    return 0
  fi
  # stage everything (respects .gitignore)
  git add -A 2>/dev/null || git add . 2>/dev/null || return 0
  # skip empty commit (no staged changes)
  if git diff --cached --quiet 2>/dev/null; then
    log " [git] no changes to commit for module $mod, skipping"
    return 0
  fi
  local msg="module $mod implemented"
  if git -c user.name="${GIT_USER_NAME:-chassis}" -c user.email="${GIT_USER_EMAIL:-chassis@local}" commit -m "$msg" >/dev/null 2>&1; then
    log " [git] committed module $mod: $msg"
  else
    log " [git] commit failed for module $mod"
  fi
}

sup_write_pid() {                    # advertise our msys + win pid for the supervisor
  mkdir -p "$SUPERVISOR_DIR"
  echo "$$ $(self_winpid)" >"$SUPERVISOR_DIR/driver.pid"
  sup_log "sequence driver started pid=$$ winpid=$(self_winpid)"
}

sup_driver_alive() {                 # is a DIFFERENT (relaunched) driver running?
  # driver.pid is written by whoever is driving: a supervisor-relaunched driver
  # writes a NEW pid. If the pid in driver.pid is OUR OWN winpid, it is just the
  # current driver advertising itself, so there is nothing to wait for.
  local line win our
  our="$(self_winpid)"
  line="$(cat "$SUPERVISOR_DIR/driver.pid" 2>/dev/null)"
  [ -n "$line" ] || return 1
  win="${line##* }"
  [ -n "$win" ] && [ "$win" != "$our" ] && pid_alive "$win"
}

sup_supervisor_active() {            # is the Layer-2 supervisor still deciding?
  local sp
  sp="$(cat "$SUPERVISOR_DIR/supervisor.pid" 2>/dev/null)"
  [ -n "$sp" ] && kill -0 "$sp" 2>/dev/null
}

sup_menu_open() {
  [ -f "$SUPERVISOR_DIR/menu.md" ]
}

# In supervise mode a non-zero module exit means the supervisor took over: it
# may be mid-fix (menu open), mid-relaunch (a new driver running), or done.
# Wait until it settles so we never blind-retry and fight the supervisor.
sup_wait_settle() {
  local waited=0
  while sup_menu_open || sup_driver_alive || sup_supervisor_active; do
    sleep 5
    waited=$(( waited + 5 ))
    if [ "$waited" -ge 3600 ]; then
      log "!! supervisor still busy after ${waited}s; continuing anyway"
      break
    fi
  done
}

# Load the ordered module list from $SEQUENCE_CONF into SEQUENCE.
# Format (one per line): MODULE_ID:path/to/prompts.json[:ROLE[:KILL_MODE]]
# '#' comments and blank lines ignored; CR/trailing whitespace stripped;
# duplicate module ids / bad ids / unreadable file -> die.
load_sequence_conf() {
  [ -f "$SEQUENCE_CONF" ] || die "sequence conf not found: $SEQUENCE_CONF (create it or pass --sequence FILE)"
  local line cleaned module file role kmode e m
  SEQUENCE=()
  while IFS= read -r line; do
    # Strip UTF-8 BOM (PowerShell Set-Content often prepends it) and CR.
    line="${line#$'\xEF\xBB\xBF'}"
    line="${line%$'\r'}"
    cleaned="${line%%#*}"                     # drop trailing '#' comment
    cleaned="$(printf '%s\n' "$cleaned" | sed 's/[[:space:]]*$//')"  # strip CR + trailing ws
    [ -n "$cleaned" ] || continue
    case "$cleaned" in
      *:*) : ;;
      *) die "bad line in sequence conf '$SEQUENCE_CONF': '$line' (expected MODULE_ID:path/to/prompts.json[:ROLE[:KILL_MODE]])" ;;
    esac
    IFS=':' read -r module file role kmode <<<"$cleaned"
    if [ -z "$module" ] || [ -z "$file" ]; then
      die "bad line in sequence conf '$SEQUENCE_CONF': '$line' (expected MODULE_ID:path/to/prompts.json[:ROLE[:KILL_MODE]])"
    fi
    case "$module" in
      *[!A-Za-z0-9_-]*) die "bad module id '$module' in sequence conf '$SEQUENCE_CONF' (allowed: [A-Za-z0-9_-], no spaces)" ;;
    esac
    if [ -n "$role" ]; then
      case "$role" in
        *[!A-Za-z0-9_-]*) die "bad role '$role' in sequence conf '$SEQUENCE_CONF' (allowed: [A-Za-z0-9_-], no spaces)" ;;
      esac
    fi
    if [ -n "$kmode" ] && [ "$kmode" != "budget" ] && [ "$kmode" != "compact" ]; then
      die "bad kill-mode '$kmode' in sequence conf '$SEQUENCE_CONF' (expected budget|compact)"
    fi
    for m in "${SEQUENCE[@]}"; do
      [ "${m%%:*}" = "$module" ] && die "duplicate module id '$module' in sequence conf '$SEQUENCE_CONF'"
    done
    SEQUENCE+=("$module:$file:$role:$kmode")
  done <"$SEQUENCE_CONF"
  [ "${#SEQUENCE[@]}" -gt 0 ] || die "sequence conf '$SEQUENCE_CONF' contains no modules"
  seqlog "loaded ${#SEQUENCE[@]} modules from $SEQUENCE_CONF"
}

print_resume_hint() {
  log "Resume commands for anything not DONE:"
  for e in "${SEQUENCE[@]}"; do
    local m="${e%%:*}" rest="${e#*:}" f="${rest%%:*}"
    if ! is_done "$m"; then
      log "  bash run_sweep.sh --sequence $SEQUENCE_CONF --from $m"
    fi
  done
}

print_summary() {
  log "============================================================"
  log "SEQUENTIAL RUN SUMMARY  ($(date '+%Y-%m-%d %H:%M:%S'))"
  log "============================================================"
  if [ -f "$RESULTS_FILE" ]; then
    printf '%-8s %-10s %s\n' "MODULE" "STATUS" "AT"
    printf '%-8s %-10s %s\n' "------" "------" "--"
    while IFS='|' read -r m s at; do
      [ -n "$m" ] && printf '%-8s %-10s %s\n' "$m" "$s" "$at"
    done <"$RESULTS_FILE"
  else
    log "(no results recorded)"
  fi
  log "Details: $LOG_FILE   per-step: .run_summaries/"
}

# Sweep ONE module in-process. $1 module, $2 prompts file, $3 role override
# ("" = inherit global --role), $4 kill-mode override ("" = inherit global).
run_one_module() {
  local module="$1" file="$2" role="$3" kmode="$4" rc attempt do_resume

  seqlog "============================================================"
  seqlog "MODULE $module  starting  ($(date '+%Y-%m-%d %H:%M:%S'))  prompts=$file"
  seqlog "============================================================"

  # First call: auto-resume when run_state.json already belongs to this module,
  # so a module cut mid-way is continued, not restarted.
  do_resume=false
  if [ "$FORCE" != true ] && state_matches "$module"; then
    do_resume=true
    log "  (state for $module found -> continuing with --resume)"
  fi
  RESUME="$do_resume"
  RESTORE=false
  run_module_sweep "$file" "$role" "$kmode"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    seqlog "MODULE $module completed successfully."
    mark_result "$module" "DONE"
    git_commit_per_module "$module"
    return 0
  fi

  if [ "$INTERRUPTED" = true ]; then
    log "Driver interrupted; leaving $module for manual --resume."
    mark_result "$module" "FAILED"
    return 1
  fi

  if [ "$SUPERVISE" = true ] && { sup_menu_open || sup_supervisor_active || sup_driver_alive; }; then
    # DP-SUPERVISOR: a supervisor is genuinely in play (menu open / agent alive /
    # a relaunched driver running) - the supervisor owns fix/retry decisions.
    log "MODULE $module exited with code $rc in supervise mode - waiting for the supervisor to settle."
    sup_log "run_module_sweep exited $rc for $module; waiting for the supervisor to settle"
    sup_wait_settle
    log "  supervisor settled; delegating one --resume to pick up the module state."
    RESUME=true
    run_module_sweep "$file" "$role" "$kmode"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      seqlog "MODULE $module completed (supervisor-assisted)."
      mark_result "$module" "DONE"
      git_commit_per_module "$module"
      return 0
    fi
    if [ "$INTERRUPTED" = true ]; then
      mark_result "$module" "FAILED"
      return 1
    fi
    log "MODULE $module still failing after supervisor assistance; stopping the driver."
    mark_result "$module" "FAILED"
    return 1
  fi
  if [ "$SUPERVISE" = true ]; then
    # No supervisor was spawned for this exit (e.g. a transient model/API error):
    # nothing to settle for, so fall through to the plain --resume retry loop
    # instead of pretending a supervisor exists and hanging forever.
    sup_log "run_module_sweep exited $rc for $module (no supervisor involved); falling back to --resume retry"
  fi

  log "MODULE $module exited with code $rc (graceful shutdown: state saved for --resume)."
  for ((attempt=1; attempt<=MAX_RESUMES; attempt++)); do
    log "  retrying $module with --resume in ${BACKOFF_S}s (attempt $attempt/$MAX_RESUMES)..."
    sleep "$BACKOFF_S"
    RESUME=true
    run_module_sweep "$file" "$role" "$kmode"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      seqlog "MODULE $module completed after resume attempt $attempt."
      mark_result "$module" "DONE"
      git_commit_per_module "$module"
      return 0
    fi
    [ "$INTERRUPTED" = true ] && break
    log "  $module still not complete after resume attempt $attempt (exit $rc)."
  done

  log "MODULE $module still failing after ${MAX_RESUMES} resume attempts; stopping the driver."
  mark_result "$module" "FAILED"
  return 1
}

# Drive the module sequence from SEQUENCE in order (run_sequential.sh main loop,
# now calling the module sweep in-process).
run_sequence() {
  local started=false module file role kmode rest rc e m nsteps
  if [ -n "$FROM" ]; then
    local found=false
    for e in "${SEQUENCE[@]}"; do
      m="${e%%:*}"
      [ "$m" = "$FROM" ] && found=true
    done
    [ "$found" = true ] || die "unknown --from module '$FROM' (one of: ${SEQUENCE[*]%%:*})"
  else
    FROM="${SEQUENCE[0]%%:*}"
    seqlog "no --from given; starting from the first module: $FROM"
  fi

  seqlog "Sequential driver starting. Modules: ${SEQUENCE[*]%%:*}"
  seqlog "role=$GLOBAL_ROLE  from=$FROM  force=$FORCE  audit=$MODE  resumes=$MAX_RESUMES  backoff=${BACKOFF_S}s  supervise=$SUPERVISE"
  seqlog "Everything is logged to $LOG_FILE (results to $RESULTS_FILE)."

  git_ensure_init_if_needed

  # DP-SUPERVISOR: advertise ourselves as the (outer) driver.
  if [ "$SUPERVISE" = true ]; then
    sup_write_pid
  fi

  started=false
  for e in "${SEQUENCE[@]}"; do
    module="${e%%:*}"
    rest="${e#*:}"
    file="${rest%%:*}"
    rest="${rest#*:}"
    role="${rest%%:*}"
    rest="${rest#*:}"
    kmode="${rest%%:*}"
    CURRENT_MODULE="$module"
    check_ipc_sentinels     # IPC: honour DEBUG/REPORT/INSTRUCT/PAUSE/INTERRUPT between modules

    wait_if_paused     # DP-SUPERVISOR: honour a PAUSE between modules

    [ "$module" = "$FROM" ] && started=true
    if [ "$started" = false ]; then
      seqlog "skipping $module (before --from $FROM)"
      continue
    fi

    [ -f "$file" ] || die "prompts file missing: $file"
    if ! nsteps="$(validate_prompts_json "$file" "$module")"; then
      die "prompts file invalid for module '$module': $file (re-run --planner --force --from $module)"
    fi
    seqlog "MODULE $module prompts OK ($nsteps steps) at $file"

    if should_skip "$module" "$file"; then
      seqlog "MODULE $module already DONE (see $RESULTS_FILE); skipping. Use --force to re-run."
      continue
    fi

    run_one_module "$module" "$file" "$role" "$kmode"
    rc=$?
    if [ "$rc" -ne 0 ]; then
      log "Driver stopped at $module (exit $rc)."
      print_summary
      print_resume_hint
      exit 1
    fi
  done

  print_summary
  seqlog "All requested modules complete."
}

# ---------------------------------------------------------------------------
# single-module sweep (the old run_agent.sh main body, refactored into a
# reusable function so sequence mode can call it in-process per module)
#   $1 prompts_file  $2 role_override ("" = inherit global --role)
#   $3 kill_mode_override ("" = inherit global --kill-mode)
# ---------------------------------------------------------------------------
run_module_sweep() {
  local mod_role="$2" mod_kill="$3" module_fallback_role nsteps
  PROMPTS_FILE="$1"
  module_fallback_role="${mod_role:-$GLOBAL_ROLE}"
  ROLE="$module_fallback_role"
  KILL_MODE="${mod_kill:-$GLOBAL_KILL_MODE}"
  # Reset per-module state so a role/kill-mode from a previous module never leaks.
  MODEL_NAME="opencode/deepseek-v4-flash-free"
  EFFORT=""
  KILL_AT=""
  KILL_PCT=90
  WINDOW_TOTAL=""
  TIER30=0
  TIER70=0
  POLL_TIERS_SPEC=""
  POLL_EVERY_S="$GLOBAL_POLL_EVERY_S"
  POLL_TOP_S=$(( POLL_EVERY_S / 3 )); [ "$POLL_TOP_S" -lt 1 ] && POLL_TOP_S=1
  POLL_LOW_S=$(( POLL_EVERY_S * 3 ))

  [ -f "$PROMPTS_FILE" ] || die "prompts file not found: $PROMPTS_FILE"
  MODULE="$(module_id)"
  TOTAL="$(prompt_count)"
  # When sequence mode set CURRENT_MODULE, the prompts JSON "module" must match.
  if [ -n "${CURRENT_MODULE:-}" ] && [ "$MODULE" != "$CURRENT_MODULE" ]; then
    die "prompts file '$PROMPTS_FILE' has module='$MODULE' but sequence conf expects '$CURRENT_MODULE'"
  fi
  # Full schema check (roles, contiguous steps, required fields) — same as planner.
  if ! nsteps="$(validate_prompts_json "$PROMPTS_FILE" "$MODULE")"; then
    die "prompts file invalid: $PROMPTS_FILE"
  fi
  [ "$TOTAL" = "$nsteps" ] || TOTAL="$nsteps"

  # Resolve a bootstrap role so the banner has a model name. Each step may
  # override this via prompts[i].role (see apply_step_role below).
  if [ -n "$ROLE" ]; then
    resolve_role "$ROLE"
  else
    ROLE="$(python3 -c "import json; print(json.load(open('$ROLE_FILE',encoding='utf-8-sig')).get('default_role','standard'))" 2>/dev/null || echo standard)"
    log " no module/--role fallback; using models.json default_role '$ROLE' until a step sets its own"
    resolve_role "$ROLE"
    module_fallback_role="$ROLE"
  fi
  # A manual --limit always wins over a role's handout threshold.
  if [ -n "$LIMIT_ARG" ]; then
    KILL_AT="$LIMIT_ARG"
  fi
  # Legacy fallback when models.json resolution was skipped (defensive; resolve_role
  # above now always runs, so this only fires for a role-less models.json).
  if [ "$HARNESS" = "pi" ] && [ -z "$ROLE" ] && [ "$MODEL_NAME" = "opencode/deepseek-v4-flash-free" ]; then
    MODEL_NAME="opencode-go/deepseek-v4-flash-free"
  fi

  resolve_kill_threshold
  SUPERVISOR_MODEL="${SUPERVISOR_MODEL:-$MODEL_NAME}"
  export SUPERVISOR_MODEL

  log "=============================="
  log " run_sweep  harness=$HARNESS kill_mode=$KILL_MODE mode=$MODE sweep"
  log " module: $MODULE   prompts=$PROMPTS_FILE ($TOTAL steps)"
  log " fallback role: ${module_fallback_role:-default}  (per-step prompts[].role wins when set)"
  log " model (bootstrap):  $MODEL_NAME   effort=${EFFORT:-default}"
  dbg "module sweep start: module=$MODULE prompts=$PROMPTS_FILE total=$TOTAL model=$MODEL_NAME role=${ROLE:-} effort=${EFFORT:-} kill_at=${KILL_AT:-} window=${WINDOW_TOTAL:-} hard_limit=${HARD_LIMIT:-}"
  if [ "$KILL_MODE" = "compact" ]; then
    log " watchdog: compact (no usage-based recycle; Pi compaction manages context; --limit ${HARD_LIMIT:-off} is the only hard ceiling)"
  elif [ -n "$HARD_LIMIT" ]; then
    log " stop agent at $KILL_AT tokens (--limit, budget mode)"
  else
    log " stop agent at $KILL_AT tokens (${KILL_PCT}% of window / role threshold, budget mode)"
  fi
  log "=============================="

  # Driver journal: mirror this sweep into .chat/<MODULE>/ so chat_window.html
  # can watch it (same store as --chat conversations; id = the module id).
  journal_open "$MODULE" "sweep $MODULE ($TOTAL steps)" "${module_fallback_role:-}"
  if [ -n "$JOURNAL_ID" ]; then
    journal_note "**$MODE sweep of \`$MODULE\`** starting ($TOTAL steps).
 prompts: \`$PROMPTS_FILE\` · harness=$HARNESS/$KILL_MODE · model=${MODEL_NAME:-?} · fallback role=${module_fallback_role:-default}${LIMIT_ARG:+ · limit=$LIMIT_ARG}"
  fi

  # --git-init-add-per-module: ensure repo exists for single-module sweeps
  # (sequence mode already handled in run_sequence). No-op when flag off or .git exists.
  if [ "$SEQUENCE_MODE" != true ]; then
    git_ensure_init_if_needed
  fi

  CURRENT_STEP="$START_STEP"
  COMPLETED_CSV=""
  CURRENT_HANDOUT=""
  STAGE="none"
  RUN_START_S="$(now_s)"

  # --restore alone is "resume + restore prompt". --step N --restore is a
  # FRESH start at N that audits existing code; it must not load leftover
  # state from a different module.
  LOAD_SAVED_STATE=false
  if [ "$RESUME" = "true" ]; then
    LOAD_SAVED_STATE=true
  elif [ "$RESTORE" = "true" ] && [ "$STEP_GIVEN" != "true" ]; then
    LOAD_SAVED_STATE=true
  fi

  if [ "$LOAD_SAVED_STATE" = "true" ]; then
    log " reading state from $STATE_FILE"
    dbg "resume/restore requested: resume=$RESUME restore=$RESTORE state=$STATE_FILE"
    # protect against stale module BEFORE loading (clear message + no partial load)
    STATE_MODULE=""
    [ -f "$STATE_FILE" ] && STATE_MODULE="$(python3 -c "import json;print(json.load(open('$STATE_FILE',encoding='utf-8-sig')).get('module',''))")"
    if [ -n "$STATE_MODULE" ] && [ "$STATE_MODULE" != "$MODULE" ]; then
      die "state file belongs to module '$STATE_MODULE' but prompts are for '$MODULE'. Use --step N --restore to start $MODULE fresh (leftover $STATE_MODULE state will be ignored), or restore the matching run_state.json."
    fi
    load_state
    log " resumed (mode=$MODE): current_step=$CURRENT_STEP completed=[$COMPLETED_CSV] stage=$STAGE"
    if [ "$STEP_GIVEN" = "true" ] && [ "$START_STEP" != "$CURRENT_STEP" ]; then
      log " WARN: --step $START_STEP ignored; --resume loaded current_step=$CURRENT_STEP from $STATE_FILE"
    fi
  else
    # fresh run (build or audit sweep); drop stale STATE (resume handoff) but KEEP
    # the per-module summary + step-record archive so every module in a sequence
    # (and every run) survives. Use --clean to wipe the archive for a true reset.
    rm -f "$STATE_FILE"
    mkdir -p "$SUMMARY_DIR"
    # Seed steps that already succeeded for THIS module from the append-only
    # archive, so a module that was interrupted (or whose state file belongs to
    # a different module) is never re-implemented from step 1.
    # --force skips the seeding: every step re-dispatches even if this exact
    # module+step pair completed before (e.g. re-running an authoring sweep).
    if [ "$FORCE" = true ]; then
      COMPLETED_CSV=""
      log " [--force] ignoring completed-step archive; every step re-dispatches"
    else
      COMPLETED_CSV="$(archive_completed_steps "$MODULE")"
      [ -n "$COMPLETED_CSV" ] && log " seeding already-completed steps from archive: [$COMPLETED_CSV]"
    fi
    log " fresh $MODE sweep from step $START_STEP"
    [ "$RESTORE" = "true" ] && log "  [--restore] will audit existing code on step $START_STEP rather than resume leftover state"
  fi

  # DP-SUPERVISOR: runtime dir, driver.pid and relaunch.sh (supervise mode only).
  if [ "$SUPERVISE" = true ]; then
    sup_init
  fi

  for ((i = CURRENT_STEP - 1; i < TOTAL; i++)); do
    step=$((i + 1))
    # DP-SUPERVISOR: honour abort/RESET/pause requests at a safe point.
    if [ "$SUPERVISE" = true ]; then
      sup_check_abort_or_reset
      wait_if_paused
    fi
    # Guard against the script file being edited while this instance runs.
    self_check || return 1
    # skip steps already completed
    case ",$COMPLETED_CSV," in *",$step,"*) log " skipping completed step $step"; record_step_row "$step" "SKIPPED" "0" "0" "" ""; continue ;; esac

    log "STEP $step / $TOTAL ===="
    [ "$SUPERVISE" = true ] && sup_log "$MODULE step $step started"
    # Track the step actually being worked so a graceful shutdown / crash saves
    # the CORRECT current_step for --resume.
    CURRENT_STEP="$step"
    dbg "step $step/$TOTAL started (mode=$MODE restore=$RESTORE resume=$RESUME completed=[$COMPLETED_CSV])"

    # Per-step model: prompts[i].role > module fallback > default_role
    apply_step_role "$step" "$module_fallback_role"

    # Journal: announce the dispatched step (title from the prompts JSON).
    if [ -n "${JOURNAL_ID:-}" ]; then
      _step_title="$(step_title "$step")"
      journal_note "Step **$step/$TOTAL**: ${_step_title:-untitled} (role ${ROLE:-default})"
    fi

    # Is this the interrupted (partially implemented) step whose handout persists?
    RESUMING_PARTIAL=false
    if [ -n "$CURRENT_HANDOUT" ] && [ "$step" = "$CURRENT_STEP" ]; then
      RESUMING_PARTIAL=true
    fi

    # Choose the prompt template.
    #   Priority: audit sweep -> AUDIT_PROMPT always.
    #             --restore, or resuming an in-progress step -> RESTORE_PROMPT.
    #             a truly fresh step -> FRESH_PROMPT.
    if [ "$MODE" = "audit" ]; then
      PROMPT="$AUDIT_PROMPT"
      log "  [audit] verifying implementation against prompt"
    elif [ "$RESTORE" = "true" ] && [ "$step" = "$CURRENT_STEP" ]; then
      PROMPT="$RESTORE_PROMPT"
      log "  [restore] auditing existing partial work"
    elif [ "$RESUMING_PARTIAL" = "true" ]; then
      PROMPT="$RESTORE_PROMPT"
      log "  [resume partial] auditing existing work"
    else
      PROMPT="$FRESH_PROMPT"
    fi

    # Materialize the handout file the inner loop will consume.
    if [ "$RESUMING_PARTIAL" = "true" ]; then
      # rewrite the authoritative interrupted handout to disk
      printf '%s\n' "$CURRENT_HANDOUT" > "$HANDOVER_FILE"
      STAGE="active"; save_state
      log " restored partial handout for step $step"
    else
      render_handout "$i"
    fi
    # IPC: honour DEBUG/REPORT/INSTRUCT/PAUSE/INTERRUPT at a safe point. This
    # runs AFTER the handout above is materialized so an INSTRUCT injection lands
    # on the handout the inner loop actually moves to handout_active.md (running
    # it earlier let a resume-partial overwrite clobber an injected instruction).
    check_ipc_sentinels

    log " starting implementation on step $step (prompt=$PROMPT)"
    init_step_metrics
    audit_done=false
    if ! inner_loop "$step"; then
      # sequence mode: graceful_shutdown already saved state + wrote the
      # INTERRUPTED summary; propagate so run_one_module can resume/retry.
      [ -n "${JOURNAL_ID:-}" ] && journal_fail \
        "step $step interrupted (watchdog/stall/signal); state saved for --resume" \
        "rerun the same command to retry"
      return 1
    fi
    # inner_loop returned 0 -> the step genuinely completed on its own.
    elapsed=$(( $(now_s) - STEP_START_S ))
    write_step_summary "$step" "SUCCESS" "$elapsed"
    tokens="$(step_tokens)"; tokens_in="${tokens%%|*}"; cache_pct="$(printf '%s\n' "$tokens" | awk -F'|' '{print $5}')"
    record_step_row "$step" "SUCCESS" "$elapsed" "$STEP_AGENT_COUNT" "$tokens_in" "$cache_pct"
    # Journal: post the step summary as the outcome message.
    [ -n "${JOURNAL_ID:-}" ] && journal_result_file \
      "$SUMMARY_DIR/step_summary_${MODULE}_${step}.md" "${tokens_in:-0}" "${cache_pct:-}"

    # ANTI-SKIP GATE: a clean exit with zero artifacts proves nothing. The agent
    # may have legitimately verified pre-existing work - or it may have decided
    # the handout was stale and skipped real work. Never take that on trust:
    # re-dispatch the SAME step ONCE with AUDIT_PROMPT, which orders an
    # independent verify-every-requirement-and-run-the-tests pass.
    if [ "$audit_done" = false ] && step_has_no_artifacts "$step"; then
      audit_done=true
      log "!! step $step reported SUCCESS but produced ZERO file changes -> forcing one independent AUDIT pass before accepting it"
      dbg "anti-skip gate fired: step=$step metrics=$(cat "$SUMMARY_DIR/.step_metrics_${MODULE}_${step}.json" 2>/dev/null | tr '\n' ' ')"
      [ -n "${JOURNAL_ID:-}" ] && journal_note \
        "⚠ Step **$step/$TOTAL** ended claiming success with **zero file changes**. Forcing an independent AUDIT pass (verify every requirement + run the tests) before accepting it."
      render_handout "$i"          # fresh handout: inner_loop needs handover.md to move into place
      PROMPT="$AUDIT_PROMPT"
      init_step_metrics
      STEP_START_S="$(now_s)"
      if ! inner_loop "$step"; then
        [ -n "${JOURNAL_ID:-}" ] && journal_fail \
          "audit pass for step $step was interrupted; state saved for --resume" \
          "rerun the same command to retry"
        return 1
      fi
      elapsed=$(( $(now_s) - STEP_START_S ))
      write_step_summary "$step" "SUCCESS" "$elapsed"
      tokens="$(step_tokens)"; tokens_in="${tokens%%|*}"; cache_pct="$(printf '%s\n' "$tokens" | awk -F'|' '{print $5}')"
      record_step_row "$step" "SUCCESS_AUDIT" "$elapsed" "$STEP_AGENT_COUNT" "$tokens_in" "$cache_pct"
      [ -n "${JOURNAL_ID:-}" ] && journal_result_file \
        "$SUMMARY_DIR/step_summary_${MODULE}_${step}.md" "${tokens_in:-0}" "${cache_pct:-}"
    fi
    # DP-SUPERVISOR: green-step heartbeat. No supervisor agent is spawned here -
    # only needs_judgement spawns the Layer-2 supervisor.
    if [ "$SUPERVISE" = true ]; then
      sup_log "$MODULE step $step SUCCESS - $(fmt_dur "$elapsed") - OK, no intervention"
    fi
  done

  print_final_summary
  # --git-init-add-per-module: commit once per module for single-module sweeps
  # (sequence mode commits via run_one_module). Avoid double-commit in sequence.
  if [ "$SEQUENCE_MODE" != true ] && [ "$GIT_INIT_ADD_PER_MODULE" = true ]; then
    git_commit_per_module "$MODULE"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# chat mode (DP-CHAT — headless chat via --chat / --prompt)
# ---------------------------------------------------------------------------
# Architecture (design plan §0–§3): one harness session per conversation; the
# session IS the conversation memory. The driver keeps only a lightweight index
# under .chat/<conversation-id>/:
#   meta.json      conversation id/role/model/harness/pinned threshold + active
#                  session pointer + past-session ledger (atomic tmp+replace)
#   history.jsonl  append-only event log (conversation_open/user/assistant/
#                  compaction/error); crash-safe by construction
#   history.md     rendered scrollback (deterministic from history.jsonl)
#   summary.md     latest compaction summary (absent until the first one)
# Follow-ups continue the SAME harness session (run_agent_cli --session SID),
# which maximizes provider prompt-cache hits. Overflow compacts instead of
# recycling handouts. A turn is recorded ONLY after its reply was extracted,
# so re-running an interrupted turn is naturally idempotent.

now_iso() { date '+%Y-%m-%dT%H:%M:%S'; }

# Append one event line to .chat/<id>/history.jsonl.
#   chat_record_event EVENT [key=value ...]
# Value prefixes: "@FILE" reads the file content as the value (used for turn
# texts, which can exceed argv limits); "json:{...}" parses a JSON literal.
# Everything else is stored as a string (known counters are int-coerced).
chat_record_event() {
  [ -n "$CHAT_DIR" ] && [ -d "$CHAT_DIR" ] || { dbg "chat_record_event: no CHAT_DIR yet, dropping event $1"; return 0; }
  local ev="$1"; shift
  local args=() kv k v
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    args+=("$k" "$v")
  done
  python3 - "$CHAT_DIR/history.jsonl" "$ev" ${args[@]+"${args[@]}"} <<'PY'
import sys, json, datetime
path, etype = sys.argv[1], sys.argv[2]
rest = sys.argv[3:]
rec = {"event": etype}
i = 0
while i + 1 < len(rest) + 1 and i < len(rest):
    k = rest[i]
    v = rest[i + 1] if i + 1 < len(rest) else ""
    i += 2
    if k == "_ts":
        rec["ts"] = v
        continue
    if isinstance(v, str) and v.startswith("@"):
        try:
            with open(v[1:], encoding="utf-8") as f:
                v = f.read()
        except Exception:
            v = ""
    elif isinstance(v, str) and v.startswith("json:"):
        try:
            v = json.loads(v[5:])
        except Exception:
            v = {}
    if k in ("turn", "chars", "summary_chars", "tail_turns", "cache_hit_pct") and isinstance(v, str):
        try:
            v = int(v)
        except Exception:
            pass
    rec[k] = v
rec.setdefault("ts", datetime.datetime.now().isoformat(timespec="seconds"))
with open(path, "a", encoding="utf-8") as f:
    f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
PY
}

# Atomic meta.json mutation dispatcher. One python process per operation;
# every op loads -> mutates -> tmp-writes -> os.replace (save_state pattern).
#   chat_meta_op init <id> <title> <role> <model> <effort> <harness> <kill_at>
#   chat_meta_op bump <turn> <sid> <usage_input> <cache_read> <cache_write>
#   chat_meta_op rotate-close <old_sid> <ended> <usage_close> <history.jsonl>
#   chat_meta_op set-active <sid> <kind> <started_turn>
chat_meta_op() {
  local op="$1"; shift
  python3 - "$CHAT_DIR/meta.json" "$op" "$@" <<'PY'
import sys, json, datetime, os
path, op = sys.argv[1], sys.argv[2]
a = sys.argv[3:]
meta = {}
if os.path.exists(path):
    try:
        meta = json.load(open(path, encoding="utf-8-sig"))
    except Exception:
        meta = {}
now = datetime.datetime.now().isoformat(timespec="seconds")
if op == "init":
    cid, title, role, model, effort, harness, kill_at = a[:7]
    meta = {
        "version": 1,
        "conversation_id": cid,
        "title": title,
        "created_at": now,
        "updated_at": now,
        "role": role,
        "model": model,
        "effort": effort,
        "harness": harness,
        "kill_at": int(kill_at) if str(kill_at).isdigit() else kill_at,
        "turns": 0,
        "status": "active",
        "active_session": {"sid": "", "kind": "", "started_turn": 0, "usage_at_last_turn": 0},
        "past_sessions": [],
    }
elif op == "bump":
    turn, sid, u_in, u_cr, u_cw = a[:5]
    meta["turns"] = int(turn)
    meta["updated_at"] = now
    s = meta.setdefault("active_session", {})
    s["sid"] = sid
    s["usage_at_last_turn"] = int(u_in or 0)
    meta["last_usage"] = {
        "input": int(u_in or 0),
        "cache_read": int(u_cr or 0),
        "cache_write": int(u_cw or 0),
    }
elif op == "touch":
    # driver journal: refresh updated_at + completed-turn count only
    meta["turns"] = int(a[0]) if a and str(a[0]).isdigit() else meta.get("turns", 0)
    meta["updated_at"] = now
elif op == "rotate-close":
    old, ended, close, histpath = a[0], a[1], a[2], a[3]
    s = meta.get("active_session") or {}
    if s.get("sid") == old:
        # per-session completed-turn count from the history log
        n = 0
        try:
            for line in open(histpath, encoding="utf-8"):
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get("event") == "user" and e.get("sid") == old:
                    n += 1
        except Exception:
            pass
        meta.setdefault("past_sessions", []).append({
            "sid": old,
            "kind": s.get("kind") or "primary",
            "turns": n,
            "ended": ended,
            "usage_close": int(close or 0),
        })
    meta["active_session"] = {"sid": "", "kind": "", "started_turn": 0, "usage_at_last_turn": 0}
    meta["updated_at"] = now
elif op == "set-active":
    sid, kind, started_turn = a[0], a[1], int(a[2])
    prev = meta.get("active_session") or {}
    meta["active_session"] = {
        "sid": sid,
        "kind": kind,
        "started_turn": started_turn,
        "usage_at_last_turn": int(prev.get("usage_at_last_turn") or 0),
    }
    meta["updated_at"] = now
else:
    raise SystemExit("unknown meta op: %s" % op)
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=2, ensure_ascii=False)
os.replace(tmp, path)
PY
}

# Load META_* scalars from .chat/<id>/meta.json. Returns 1 if unreadable.
chat_meta_get() {   # $1 = chatdir
  local out
  out="$(python3 - "$1/meta.json" <<'PY'
import sys, json
try:
    d = json.load(open(sys.argv[1], encoding="utf-8-sig"))
except Exception:
    raise SystemExit(1)
s = d.get("active_session") or {}
print("|".join(str(x) for x in [
    d.get("role", ""),
    d.get("model", ""),
    "" if d.get("effort") is None else d.get("effort"),
    d.get("harness", ""),
    d.get("kill_at", ""),
    d.get("turns", 0),
    d.get("status", ""),
    s.get("sid", ""),
    d.get("created_at", ""),
]))
PY
)" || return 1
  IFS='|' read -r META_ROLE META_MODEL META_EFFORT META_HARNESS META_KILL_AT META_TURNS META_STATUS META_ACTIVE_SID META_CREATED_AT <<<"$out"
}

# Fixed turn-1 preamble (DP-CHAT §7.1): role charter + working-dir contract +
# output convention. NO timestamps/dates/counters/git state — nothing that
# changes between turns — so the provider prompt cache stays stable for the
# whole conversation. Generated once at conversation open; later turns recover
# the original bytes from the conversation_open event (see chat_get_preamble).
chat_build_preamble() {
  local desc
  desc="$(python3 - "$ROLE_FILE" "$ROLE" <<'PY'
import sys, json
try:
    d = json.load(open(sys.argv[1], encoding="utf-8-sig"))
    print((d.get("roles", {}).get(sys.argv[2]) or {}).get("description", ""))
except Exception:
    print("")
PY
)"
  CHAT_PREAMBLE="You are the user's autonomous assistant in an ongoing multi-turn conversation (models.json role: $ROLE).
Role charter: ${desc:-general-purpose engineering assistant}.
Working-directory contract: you operate in $WORKDIR. Repo-relative paths mentioned by the user refer to files in this tree; read referenced files yourself with your tools instead of asking for their contents.
Output convention: answer the user's request directly. Your FINAL message of each turn is the answer delivered back to the user; make it self-contained."
  CHAT_PREAMBLE_SHA="$(printf '%s' "$CHAT_PREAMBLE" | python3 -c 'import sys,hashlib; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')"
}

# Recover the ORIGINAL preamble bytes of a conversation from its
# conversation_open event (survives models.json edits between turns).
chat_get_preamble() {   # $1 = outfile -> 0 on success
  python3 - "$CHAT_DIR/history.jsonl" "$1" <<'PY'
import sys, json
src, out = sys.argv[1], sys.argv[2]
for line in open(src, encoding="utf-8"):
    try:
        e = json.loads(line)
    except Exception:
        continue
    if e.get("event") == "conversation_open" and isinstance(e.get("preamble_text"), str):
        with open(out, "w", encoding="utf-8") as f:
            f.write(e["preamble_text"])
        raise SystemExit(0)
raise SystemExit(1)
PY
}

# Index a chat session's on-disk file into .chat/<id>/sessions.idx (sid|basename),
# so tools (e.g. chat_window.html) can locate the raw transcript of every session
# ever attached to this conversation, including past ones after compaction.
# Best-effort: never fatal, dedup by sid, empty basename for non-pi harnesses.
chat_index_session_file() {
  [ -n "$CHAT_DIR" ] && [ -d "$CHAT_DIR" ] && [ -n "$1" ] || return 0
  local fn base=""
  if [ "$HARNESS" = "pi" ]; then
    fn="$(pi_session_file "$1" 2>/dev/null)"
    [ -n "$fn" ] || return 0
    base="${fn##*/}"
  fi
  grep -qs "^$1|" "$CHAT_DIR/sessions.idx" 2>/dev/null && return 0
  printf '%s|%s\n' "$1" "$base" >>"$CHAT_DIR/sessions.idx" 2>/dev/null || true
}

chat_init_conversation() {
  local pre_file="$WORKDIR/.chat_preamble.tmp"
  printf '%s\n' "$CHAT_PREAMBLE" >"$pre_file"
  : >"$CHAT_DIR/history.jsonl"
  chat_meta_op init "$CONVERSATION_ID" "$CHAT_TITLE" "$ROLE" "$MODEL_NAME" "${EFFORT:-}" "$HARNESS" "${KILL_AT:-}"
  chat_record_event conversation_open role="$ROLE" model="$MODEL_NAME" effort="${EFFORT:-}" harness="$HARNESS" preamble_sha="$CHAT_PREAMBLE_SHA" preamble_text="@$pre_file"
  rm -f "$pre_file"
  chat_render_history_md "$CHAT_DIR"
  log "[chat] conversation store ready: $CHAT_DIR (preamble sha ${CHAT_PREAMBLE_SHA:0:12}...)"
}

# Pre-flight checks on the user turn (DP-CHAT §12.1–§12.2): size warning near
# the Windows argv ceiling and non-fatal warnings for backtick-quoted repo
# paths that do not exist. NEVER inline referenced files into the turn.
chat_preflight_prompt() {
  local size
  size="$(printf '%s' "$CHAT_USER_TEXT" | wc -c | tr -d ' ')"
  if [ "$size" -gt 24576 ]; then
    log "!! [chat] prompt is ${size}B (near the ~32KB Windows argv limit); consider splitting the turn into a follow-up message"
  fi
  local missing
  missing="$(printf '%s\n' "$CHAT_USER_TEXT" | grep -oE '`[^`]+`' | tr -d '`' | sort -u | while IFS= read -r p; do
    case "$p" in
      /*|*\\*) continue ;;
      *" "*) continue ;;
      */*|*.md|*.txt|*.json|*.sh|*.py|*.ts|*.tsx|*.js|*.yaml|*.yml|*.toml|*.conf)
        [ -e "$p" ] || printf '%s\n' "$p" ;;
    esac
  done)"
  if [ -n "$missing" ]; then
    log "!! [chat] WARN: backtick-mentioned paths not found in the repo (non-fatal; the agent may create them dynamically):"
    while IFS= read -r p; do [ -n "$p" ] && log "     - $p"; done <<<"$missing"
  fi
}

# Is a harness session resumable? Pi: its JSONL exists under $PI_SESSION_DIR.
# OpenCode: `opencode export` still returns messages for it.
chat_session_alive() {   # $1 = sid -> 0 = resumable
  [ -n "$1" ] || return 1
  if [ "$HARNESS" = "pi" ]; then
    [ -n "$(pi_session_file "$1")" ]
  else
    [ -n "$(oc_timeout opencode export "$1" 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    print("1" if d.get("messages") else "")
except Exception:
    pass')" ]
  fi
}

# Cumulative usage snapshot for a session: "<input>|<cacheRead>|<cacheWrite>|<hit%>".
chat_usage_snapshot() {   # $1 = sid
  local u c cr cw hit rest
  u="$(usage_tokens "$1" 2>/dev/null || true)"
  c="$(session_cache "$1" 2>/dev/null || true)"
  cr="${c%%|*}"; rest="${c#*|}"; cw="${rest%%|*}"; hit="${rest#*|}"
  echo "${u:-0}|${cr:-0}|${cw:-0}|${hit:-0}"
}

# Spawn a NEW agent session with $1 as the first message, discover its sid
# (same discovery machinery as inner_loop). Sets RUN_PID/SID; returns 1 when
# no sid surfaced within SESSION_DISCOVERY_TIMEOUT_S (wedged CLI at startup).
chat_spawn_and_discover() {
  local msg="$1" start_ms disc_start
  msg="$(with_context_injection "$msg")"
  mkdir -p "$PI_SESSION_DIR"
  start_ms="$(now_ms)"
  dbg "[chat] spawn new session ($(printf '%s' "$msg" | wc -c | tr -d ' ')B message)"
  ( cd "$WORKDIR" && run_agent_cli "$msg" ) >"$WORKDIR/_run.log" 2>&1 < /dev/null &
  RUN_PID=$!
  SID=""
  disc_start="$(now_s)"
  while [ $(( $(now_s) - disc_start )) -lt "$SESSION_DISCOVERY_TIMEOUT_S" ]; do
    if [ "$HARNESS" = "pi" ]; then
      SID="$(pi_sid_from_log)"
      [ -n "$SID" ] && break
    else
      SID="$(opencode_session_after "$start_ms" "$THIS_PROJECT")"
      [ -n "$SID" ] && break
    fi
    kill -0 "$RUN_PID" 2>/dev/null || break
    sleep 1
  done
  [ -n "$SID" ] || SID="$(pi_newest_session)"   # pi fallback; empty for opencode
  if [ -z "$SID" ]; then
    kill_tree_win "$(native_pid "$RUN_PID")" 2>/dev/null
    kill "$RUN_PID" 2>/dev/null; wait "$RUN_PID" 2>/dev/null
    RUN_PID=""
    return 1
  fi
  chat_index_session_file "$SID"
  log " session: $SID"
  return 0
}

# Continue an EXISTING session ($1 = sid) with $2 as the next user message.
chat_spawn_continue() {
  local msg
  msg="$(with_context_injection "$2")"
  dbg "[chat] continue session $1 ($(printf '%s' "$msg" | wc -c | tr -d ' ')B message)"
  ( cd "$WORKDIR" && run_agent_cli --session "$1" "$msg" ) >"$WORKDIR/_run.log" 2>&1 < /dev/null &
  RUN_PID=$!
}

# Reply extraction (DP-CHAT §10). Prints a status on stdout:
#   ok      last assistant message had text
#   empty   last assistant message had no text (an empty answer is data)
#   error   that message recorded a model error (caller fails the turn)
#   missing no assistant message found / transcript unreadable
# Text is written to $2. Pi: tolerant torn-line scan of the session JSONL.
# OpenCode: reverse walk over `opencode export` messages.
chat_extract_reply() {   # $1 sid  $2 outfile
  local sid="$1" out="$2"
  if [ "$HARNESS" = "pi" ]; then
    local f
    f="$(pi_session_file "$sid")"
    [ -n "$f" ] || { echo "missing"; return 0; }
    python3 - "$f" "$out" <<'PY'
import sys, json
f, out = sys.argv[1], sys.argv[2]
last = None
for line in open(f, encoding="utf-8", errors="replace"):
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    if e.get("type") != "message":
        continue
    m = e.get("message") or {}
    if m.get("role") != "assistant":
        continue
    txt = "\n".join(c.get("text", "") for c in (m.get("content") or [])
                    if c.get("type") == "text" and (c.get("text") or "").strip()).strip()
    last = (m.get("stopReason") == "error", txt)
if last is None:
    print("missing")
    raise SystemExit(0)
had_error, txt = last
with open(out, "w", encoding="utf-8") as f:
    f.write(txt)
print("error" if had_error else ("empty" if txt == "" else "ok"))
PY
  else
    oc_timeout opencode export "$sid" 2>/dev/null | python3 -c '
import sys, json
out = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:
    print("missing"); raise SystemExit(0)
for m in reversed(d.get("messages", [])):
    inf = m.get("info") or {}
    if inf.get("role") != "assistant":
        continue
    txt = "\n".join(p.get("text", "") for p in m.get("parts", [])
                    if p.get("type") == "text" and (p.get("text") or "").strip()).strip()
    with open(out, "w", encoding="utf-8") as f:
        f.write(txt)
    print("error" if inf.get("error") else ("empty" if txt == "" else "ok"))
    raise SystemExit(0)
print("missing")' "$out"
  fi
}

# Deterministic regeneration of history.md from meta.json + history.jsonl
# (safe to run any time; never append-only).
chat_render_history_md() {   # $1 = chatdir
  python3 - "$1" <<'PY'
import sys, json, os
chatdir = sys.argv[1]
try:
    meta = json.load(open(os.path.join(chatdir, "meta.json"), encoding="utf-8-sig"))
except Exception:
    meta = {}
evs = []
try:
    for line in open(os.path.join(chatdir, "history.jsonl"), encoding="utf-8"):
        try:
            evs.append(json.loads(line))
        except Exception:
            continue
except FileNotFoundError:
    pass

def short_ts(iso):
    return (iso or "")[:16].replace("T", " ")

def kfmt(n):
    try:
        n = int(n)
    except Exception:
        return "?"
    return "%.1fk" % (n / 1000.0)

L = []
L.append("# Conversation %s" % meta.get("conversation_id", "?"))
hdr = "role=%s · model=%s · harness=%s · opened %s" % (
    meta.get("role", "?"), meta.get("model", "?"), meta.get("harness", "?"), short_ts(meta.get("created_at")))
if meta.get("title"):
    hdr += " · %s" % meta["title"]
L.append(hdr)
L.append("")
prev_in = {}
for e in evs:
    t = e.get("event")
    if t == "user":
        L.append("---")
        src = (", from %s" % e["source"]) if e.get("source") else ""
        L.append("## Turn %s — user (%s%s)" % (e.get("turn", "?"), short_ts(e.get("ts")), src))
        L.append("")
        L.append(e.get("text", ""))
        L.append("")
    elif t == "assistant":
        u = e.get("usage") or {}
        inp = int(u.get("input") or 0)
        sid = e.get("sid") or ""
        delta = inp - int(prev_in.get(sid) or 0)
        prev_in[sid] = inp
        L.append("## Turn %s — assistant (%s · Δin %s · cache %s%%)" % (
            e.get("turn", "?"), short_ts(e.get("ts")), kfmt(delta), e.get("cache_hit_pct", "?")))
        L.append("")
        L.append(e.get("text", "") or "(empty reply)")
        L.append("")
    elif t == "compaction":
        L.append("---")
        L.append("_Context compacted after turn %s (session `%s` → `%s`, summary %s chars, tail %s turns)._" % (
            e.get("turn", "?"), e.get("old_sid", "?"), e.get("new_sid", "?"),
            e.get("summary_chars", "?"), e.get("tail_turns", "?")))
        L.append("")
tmp = os.path.join(chatdir, "history.md.tmp")
with open(tmp, "w", encoding="utf-8") as f:
    f.write("\n".join(L) + "\n")
os.replace(tmp, os.path.join(chatdir, "history.md"))
PY
}

# ---------------------------------------------------------------------------
# driver journal (.chat/ mirror for the non-chat modes)
# Every driver mode mirrors its progress into .chat/<id>/ using the SAME store
# shape as DP-CHAT conversations (meta.json + history.jsonl + history.md), so
# chat_window.html can watch --prompts / --sequence / --planner runs exactly
# like --chat conversations. Dispatched work renders as user bubbles ("from"
# notes), outcomes as assistant messages, failures as red error notices.
# Entry id: the module id when one exists (sweeps continue their module's
# entry across runs/resumes); otherwise a timestamp <mode>-YYMMDD-HHMMSS.
# Best-effort by construction: every helper no-ops without a journal.
# ---------------------------------------------------------------------------
JOURNAL_ID=""
JOURNAL_TURNS=0

journal_new_id() { date '+%y%m%d-%H%M%S'; }

journal_last_turn() {   # $1 conversation id -> highest recorded turn number (0 if none)
  local n=0
  if [ -f ".chat/$1/history.jsonl" ]; then
    n="$(python3 - ".chat/$1/history.jsonl" <<'PY'
import sys, json
best = 0
try:
    for line in open(sys.argv[1], encoding="utf-8"):
        try:
            t = (json.loads(line) or {}).get("turn")
        except Exception:
            continue
        try:
            t = int(t)
        except (TypeError, ValueError):
            continue
        if t > best:
            best = t
except FileNotFoundError:
    pass
print(best)
PY
)"
    case "$n" in ''|*[!0-9]*) n=0 ;; esac
  fi
  echo "$n"
}

journal_open() {   # $1 id  $2 title  $3 role("" = unknown)
  JOURNAL_ID="$1"
  JOURNAL_TURNS=0
  [ -n "$JOURNAL_ID" ] || return 0
  case "$JOURNAL_ID" in *[!A-Za-z0-9_-]*) dbg "journal: bad id '$JOURNAL_ID', journal disabled"; JOURNAL_ID=""; return 0 ;; esac
  CHAT_DIR=".chat/$JOURNAL_ID"
  mkdir -p "$CHAT_DIR" 2>/dev/null || { JOURNAL_ID=""; return 0; }
  if [ -f "$CHAT_DIR/meta.json" ]; then
    # existing entry: keep appending (a re-run continues its conversation)
    JOURNAL_TURNS="$(journal_last_turn "$JOURNAL_ID")"
  else
    : >"$CHAT_DIR/history.jsonl"
    chat_meta_op init "$JOURNAL_ID" "$2" "${3:-}" "${MODEL_NAME:-}" "${EFFORT:-}" "$HARNESS" "${KILL_AT:-}"
    log "[journal] recording this run in $CHAT_DIR (visible in chat_window.html)"
  fi
}

journal_event() {  # EVENT key=value ...  (same kv syntax as chat_record_event)
  [ -n "$JOURNAL_ID" ] && [ -d ".chat/$JOURNAL_ID" ] || return 0
  CHAT_DIR=".chat/$JOURNAL_ID"
  chat_record_event "$@"
  chat_render_history_md "$CHAT_DIR"
}

journal_note() {   # $1 markdown text -> user bubble (the driver's dispatch)
  [ -n "$JOURNAL_ID" ] || return 0
  JOURNAL_TURNS=$((JOURNAL_TURNS + 1))
  journal_event user turn="$JOURNAL_TURNS" chars="${#1}" text="$1"
  chat_meta_op touch "$JOURNAL_TURNS"
}

journal_say() {    # $1 markdown text -> assistant bubble (an outcome)
  [ -n "$JOURNAL_ID" ] || return 0
  JOURNAL_TURNS=$((JOURNAL_TURNS + 1))
  journal_event assistant turn="$JOURNAL_TURNS" chars="${#1}" text="$1"
  chat_meta_op touch "$JOURNAL_TURNS"
}

journal_result_file() {  # $1 md file $2 tokens_in $3 cache_pct -> assistant message with usage bits
  [ -n "$JOURNAL_ID" ] && [ -f "$1" ] || return 0
  JOURNAL_TURNS=$((JOURNAL_TURNS + 1))
  journal_event assistant turn="$JOURNAL_TURNS" source="$1" \
    chars="$(wc -c <"$1" | tr -d ' ')" cache_hit_pct="${3:-}" \
    usage="json:{\"input\":${2:-0}}" text="@$1"
  chat_meta_op touch "$JOURNAL_TURNS"
}

journal_fail() {   # $1 message $2 action hint -> red error notice
  [ -n "$JOURNAL_ID" ] || return 0
  journal_event error message="$1" action="${2:-}"
}

step_title() {     # $1 = 1-based step -> prompts[i].title ("" when absent)
  python3 - "$PROMPTS_FILE" "$1" <<'PY'
import sys, json
try:
    d = json.load(open(sys.argv[1], encoding="utf-8-sig"))
    print(d["prompts"][int(sys.argv[2]) - 1].get("title", ""))
except Exception:
    print("")
PY
}

# Rebuild/compaction seed (DP-CHAT §9, §12.4): preamble + summary.md + last K
# verbatim turn pairs + the CURRENT user turn, dispatched as ONE first message
# into a fresh session. $1 = outfile, $2 = user-text file.
chat_build_seed() {   # $1 outfile  $2 userfile
  local out="$1" userfile="$2" pre_file="$WORKDIR/.chat_seed_pre.tmp"
  chat_get_preamble "$pre_file" || printf '%s\n' "$CHAT_PREAMBLE" >"$pre_file"
  python3 - "$CHAT_DIR" "$out" "$CHAT_SEED_TAIL_TURNS" "$pre_file" "$userfile" <<'PY'
import sys, json, os
chatdir, out, K, pre_file, userfile = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5]
preamble = open(pre_file, encoding="utf-8").read().rstrip("\n")
summary = ""
sp = os.path.join(chatdir, "summary.md")
if os.path.exists(sp):
    summary = open(sp, encoding="utf-8").read().strip()
evs = []
try:
    for line in open(os.path.join(chatdir, "history.jsonl"), encoding="utf-8"):
        try:
            evs.append(json.loads(line))
        except Exception:
            continue
except FileNotFoundError:
    pass
turns = {}
order = []
for e in evs:
    if e.get("event") not in ("user", "assistant"):
        continue
    t = e.get("turn")
    if t is None:
        continue
    if t not in turns:
        turns[t] = {}
        order.append(t)
    turns[t][e["event"]] = e.get("text") or ""
completed = [t for t in order if turns[t].get("user") and turns[t].get("assistant")]
tail = completed[-K:] if K > 0 else []
blocks = []
for t in tail:
    blocks.append("### Turn %s — user\n%s" % (t, turns[t]["user"]))
    blocks.append("### Turn %s — assistant\n%s" % (t, turns[t]["assistant"]))
recent = "\n\n".join(blocks) if blocks else "(no prior turns recorded)"
usertext = open(userfile, encoding="utf-8").read().rstrip("\n")
seed = (
    preamble + "\n\n---\n"
    "CONTINUATION of an earlier conversation. Below is a summary of everything so far,\n"
    "followed by the most recent exchanges verbatim.\n\n"
    "## Summary\n" + (summary or "(no summary available)") + "\n\n"
    "## Recent messages (verbatim)\n" + recent + "\n\n---\n"
    "Now continue this conversation. The next message from the user follows:\n\n"
    + usertext + "\n"
)
with open(out, "w", encoding="utf-8") as f:
    f.write(seed)
PY
  rm -f "$pre_file"
}

# Compaction (DP-CHAT §9): ask the DYING session to write .chat/<id>/summary.md
# (bounded by HANDOVER_TIMEOUT_S), fall back to a deterministic synthesis from
# the prior summary + transcript activity snapshot + history.md tail, then close
# the old session in meta. The caller re-dispatches the interrupted turn into a
# fresh seeded session (the dispatch loop's rebuild branch).
chat_compact() {   # $1 = used tokens at crossing
  local old_sid="$SID" used_at="${1:-0}"
  log "[chat] compaction: asking dying session $old_sid to write $CHAT_DIR/summary.md (deadline ${HANDOVER_TIMEOUT_S}s)"
  # Post-kill grace so the killed CLI finishes appending its last entries.
  if [ "$HARNESS" = "pi" ]; then sleep 8; else sleep "$STOP_SLEEP_S"; fi
  local activity
  activity="$(session_activity "$old_sid" 2>/dev/null || true)"
  local writer_log="$WORKDIR/_handout.log"
  : >"$writer_log"
  local compact_prompt="The conversation context window is nearly full. Write the file $CHAT_DIR/summary.md (relative to $WORKDIR; create the directory if needed) summarizing this conversation for a successor session: (1) durable facts and constraints established so far; (2) decisions made and their rationale; (3) files touched, with paths; (4) the user's open questions and expressed preferences; (5) anything referenced but not yet resolved. After the file exists and is complete, stop. Do not continue answering the pending question."
  ( cd "$WORKDIR" && run_agent_cli --session "$old_sid" "$compact_prompt" ) >"$writer_log" 2>&1 < /dev/null &
  WRITER_PID=$!
  local produced=false model_err=false sec
  for sec in $(seq 1 "$HANDOVER_TIMEOUT_S"); do
    [ -s "$CHAT_DIR/summary.md" ] && { produced=true; break; }
    if [ -n "$(session_errored "$old_sid" 2>/dev/null)" ]; then model_err=true; break; fi
    if ! kill -0 "$WRITER_PID" 2>/dev/null; then
      [ -s "$CHAT_DIR/summary.md" ] && produced=true
      break
    fi
    if [ $(( sec % 15 )) -eq 0 ]; then
      log "[chat]   ...waiting for summary ${sec}s (writer alive, _handout.log=$([ -s "$writer_log" ] && echo "$(wc -c <"$writer_log" | tr -d ' ')B" || echo empty))"
    fi
    sleep 1
  done
  kill_tree_win "$(native_pid "$WRITER_PID")" 2>/dev/null
  kill "$WRITER_PID" 2>/dev/null; wait "$WRITER_PID" 2>/dev/null
  WRITER_PID=""
  if [ "$produced" != true ]; then
    if [ "$model_err" = true ]; then
      log "!! [chat] summary writer hit a model error -> deterministic fallback summary"
    else
      log "!! [chat] summary not produced within ${HANDOVER_TIMEOUT_S}s -> deterministic fallback summary"
      if [ -s "$writer_log" ]; then
        log "!! _handout.log tail:"
        tail -n 5 "$writer_log" | sed 's/^/!!   /'
      else
        log "!! _handout.log EMPTY -> writer stalled inside CLI init (known post-kill race)"
      fi
    fi
    chat_fallback_summary "$activity"
  else
    log "[chat] summary written: $CHAT_DIR/summary.md ($(wc -c <"$CHAT_DIR/summary.md" | tr -d ' ')B)"
  fi
  chat_meta_op rotate-close "$old_sid" compacted "$used_at" "$CHAT_DIR/history.jsonl"
  CHAT_PENDING_COMPACTION="$old_sid"
  SID=""
  return 0
}

# Deterministic summary fallback: prior summary + live transcript activity
# snapshot + verbatim history.md tail (never loses information that existed).
chat_fallback_summary() {   # $1 = activity snapshot (may be empty)
  {
    echo "# Conversation summary (deterministic fallback — the model writer was unavailable)"
    echo "_Generated $(date '+%Y-%m-%d %H:%M:%S') by run_sweep.sh after the summary writer failed._"
    echo
    if [ -f "$CHAT_DIR/summary.md" ]; then
      echo "## Previous summary (kept below verbatim)"
      echo
      cat "$CHAT_DIR/summary.md"
      echo
    fi
    if [ -n "$1" ]; then
      echo "$1"
      echo
    fi
    echo "## Recent exchanges (verbatim tail of history.md)"
    echo
    tail -n 80 "$CHAT_DIR/history.md" 2>/dev/null
  } >"$CHAT_DIR/summary.md.new"
  mv "$CHAT_DIR/summary.md.new" "$CHAT_DIR/summary.md"
  log "[chat] fallback summary written: $CHAT_DIR/summary.md"
}

# Fatal end-of-turn (persistent model error / wedged startup / extraction
# failure). The turn was NOT recorded -> rerunning the same command retries it.
chat_fail_turn() {   # $1 = reason
  local reason="$1"
  log "!! [chat] turn ${CHAT_TURN:-?} failed: $reason"
  chat_record_event error turn="${CHAT_TURN:-}" sid="${SID:-}" message="$reason" action="turn_not_recorded_rerun_to_retry"
  [ -d ".chat" ] && printf '%s|%s|%s|%s|%s|%s|%s\n' "$CONVERSATION_ID" "${CHAT_TURN:-?}" "FAILED" "0" "" "" "${SID:-}" >>"$CHAT_RECORDS_FILE" 2>/dev/null || true
  rm -f "$WORKDIR/.chat_user_input.tmp" 2>/dev/null || true
  dbg "[chat] fail_turn: conv=$CONVERSATION_ID turn=${CHAT_TURN:-} sid=${SID:-} reason=$reason"
  exit 1
}

# Chat-aware graceful shutdown (signals, stalls, tool hangs). Nothing special
# to save: the harness transcript is already on disk and history.jsonl simply
# lacks the interrupted turn (AC4). Records an error event for forensics only.
chat_graceful_shutdown() {
  log "!! [chat] graceful shutdown: harness transcript kept; the in-flight turn was NOT recorded — rerun the same command to retry it"
  dbg "[chat] graceful shutdown: conv=$CONVERSATION_ID turn=${CHAT_TURN:-} sid=${SID:-} run_pid=${RUN_PID:-} writer_pid=${WRITER_PID:-}"
  if [ -n "${CHAT_DIR:-}" ] && [ -d "$CHAT_DIR" ]; then
    chat_record_event error turn="${CHAT_TURN:-}" sid="${SID:-}" message="driver interrupted (signal/stall/tool-hang); turn not completed" action="rerun_same_command_to_retry"
  fi
  if [ -n "${RUN_PID:-}" ] && kill -0 "$RUN_PID" 2>/dev/null; then
    log "  killing running agent (pid=$RUN_PID)"
    kill_tree_win "$(native_pid "$RUN_PID")"
    kill "$RUN_PID" 2>/dev/null; wait "$RUN_PID" 2>/dev/null
  fi
  if [ -n "${WRITER_PID:-}" ] && kill -0 "$WRITER_PID" 2>/dev/null; then
    log "  killing summary writer (pid=$WRITER_PID)"
    kill_tree_win "$(native_pid "$WRITER_PID")"
    kill "$WRITER_PID" 2>/dev/null; wait "$WRITER_PID" 2>/dev/null
  fi
  exit 1
}

# Simplified inner_loop poll (DP-CHAT §6). Differences vs sweep inner_loop:
#   clean process exit  = SUCCESS (agent ending its turn IS completion; no
#                         premature-stop nudge), unless the transcript recorded
#                         a model error;
#   threshold crossing  = compaction (status "crossed"), not handout recycle;
#   transient errors    = same-session continue nudge (bounded, wedge-checked);
#   stall / tool hang   = status "stalled" -> chat_graceful_shutdown.
# Sets CHAT_POLL_STATUS: ok | err (CHAT_LAST_ERR) | crossed (CHAT_USED_AT_CROSS) | stalled.
chat_poll_loop() {
  CHAT_POLL_STATUS=""
  CHAT_LAST_ERR=""
  local used logsz pct poll_s cache_stats cr cw hit cache_log tool_in_flight tool_log
  local session_err now crossed=false stalled=false
  wedge_reset              # wedge-streak + usage-at-last-drop, fresh per session
  last_used=""
  last_logsz=-1
  last_progress="$(now_s)"
  tool_since=""
  tool_logged=0
  tool_diag_logged=0
  CONTINUE_NUDGE_TS=""
  CONTINUE_NUDGES_TOTAL=0
  while :; do
    check_ipc_sentinels
    # USER FLIGHT PROMPT (.prompt_flight.md): deliver a mid-flight user comment
    # into the live session without ending the turn. Freshness-guarded (stale
    # drops are left in place and reported, never delivered); consumed by
    # rename so it fires exactly once. Mirrors the continue-nudge recovery
    # shape: stop the current process, continue the SAME sid, reset trackers.
    if [ -f "$CHAT_FLIGHT_FILE" ]; then
      local f_age f_ts flight=""
      f_ts="$(stat -c %Y "$CHAT_FLIGHT_FILE" 2>/dev/null || echo 0)"
      f_age=$(( $(now_s) - f_ts ))
      if [ "$f_age" -le "$CHAT_FLIGHT_MAX_AGE_S" ]; then
        flight="$(cat "$CHAT_FLIGHT_FILE" 2>/dev/null || true)"
        if printf '%s' "$flight" | grep -q '[^[:space:]]'; then
          mv "$CHAT_FLIGHT_FILE" "$CHAT_FLIGHT_FILE.consumed-$(date '+%Y%m%d-%H%M%S')"
          log "!! [chat] FLIGHT PROMPT consumed (age=${f_age}s) -> delivering into session ${SID:-?}"
          if [ -n "${RUN_PID:-}" ] && kill -0 "$RUN_PID" 2>/dev/null; then
            ipc_interrupt
          fi
          local fmsg
          fmsg="$(printf '## USER MESSAGE (dropped mid-flight)\n\n%s\n\nAcknowledge in one line, take it into account, and CONTINUE exactly where you left off.' "$flight")"
          chat_spawn_continue "$SID" "$(with_context_injection "$fmsg")"
          last_used=""; last_logsz=-1; last_progress="$(now_s)"
          tool_since=""; tool_logged=0; tool_diag_logged=0
          sleep 2
          continue
        fi
      else
        log "!! [chat] ignoring STALE flight prompt (age=${f_age}s > ${CHAT_FLIGHT_MAX_AGE_S}s) - re-save $CHAT_FLIGHT_FILE to deliver it"
      fi
    fi
    # Clean exit = the agent finished its answer. Normal case in chat.
    if ! kill -0 "$RUN_PID" 2>/dev/null; then
      session_err="$(session_errored "$SID")"
      if [ -n "$session_err" ]; then
        CHAT_POLL_STATUS="err"; CHAT_LAST_ERR="$session_err"
        return 0
      fi
      CHAT_POLL_STATUS="ok"
      return 0
    fi
    used="$(usage_tokens "$SID")"
    logsz="$(wc -c <"$WORKDIR/_run.log" 2>/dev/null || echo 0)"
    if [ -n "$used" ] && [ "$used" -ge 0 ] 2>/dev/null; then
      poll_s="$(poll_interval_for "$used")"
      pct=$(( used * 100 / WINDOW_TOTAL ))
    else
      poll_s="$POLL_EVERY_S"
      pct="?"
    fi
    cache_stats="$(session_cache "$SID")"
    cache_log=""
    if [ -n "$cache_stats" ]; then
      cr="${cache_stats%%|*}"; cw="${cache_stats#*|}"; cw="${cw%%|*}"; hit="${cache_stats##*|}"
      cache_log=" cacheRead=$cr hit=${hit}%"
    fi
    tool_in_flight=""
    if [ "$HARNESS" = "pi" ]; then
      [ "$(pi_session_tool_in_flight "$SID")" = "1" ] && tool_in_flight="1"
    fi
    tool_log=""; [ -n "$tool_in_flight" ] && tool_log=" [tool in flight]"
    dbg "[chat] poll: used=${used:-?} pct=${pct:-?} poll_s=$poll_s tool=${tool_in_flight:-0}"
    log "[chat]   usage=${used:-?}/${KILL_AT} (${pct}%)$cache_log$tool_log"
    # Model/API-level failure: authoritative signal is the transcript error.
    session_err="$(session_errored "$SID")"
    if [ -n "$session_err" ]; then
      log "!! [chat] session $SID recorded a model error: $session_err"
      kill_tree_win "$(native_pid "$RUN_PID")"
      kill "$RUN_PID" 2>/dev/null; wait "$RUN_PID" 2>/dev/null
      # Wedge detection (outage-tolerant): during a network outage every nudge
      # re-fails at the SAME token count within seconds, so only declare the
      # session wedged after WEDGE_MAX_CONSECUTIVE consecutive zero-progress
      # errors, backing off between retries (WEDGE_BACKOFF_SCHEDULE).
      if ! wedge_record "${used:-0}"; then
        log "!! [chat] session $SID wedged after $WEDGE_CONSEC consecutive zero-progress errors (${used:-?}) -> giving up on this session"
        CHAT_POLL_STATUS="err"; CHAT_LAST_ERR="wedged: $session_err"
        return 0
      fi
      # Transient stream drop -> same-session "continue your answer" nudge.
      if is_transient_model_error "$session_err" && continue_nudge_try; then
        log "   [chat] transient stream drop -> continue-nudge ($(continue_nudge_window_used)/$MAX_CONTINUE_NUDGES per ${CONTINUE_NUDGE_WINDOW_S}s, total ${CONTINUE_NUDGES_TOTAL}/$CONTINUE_MAX_TOTAL)"
        wedge_backoff_sleep "$WEDGE_CONSEC"
        chat_spawn_continue "$SID" "$CHAT_CONTINUE_PROMPT"
        last_used=""; last_logsz=-1; last_progress="$(now_s)"
        continue
      fi
      CHAT_POLL_STATUS="err"; CHAT_LAST_ERR="$session_err"
      return 0
    fi
    # Context overflow -> compaction (budget: role threshold; compact: only --limit).
    if [ "$KILL_MODE" = "compact" ]; then
      if [ -n "$HARD_LIMIT" ] && [ -n "$used" ] && [ "$used" -ge "$HARD_LIMIT" ]; then
        log "!! [chat] --limit ($HARD_LIMIT) reached -> compaction"
        kill_tree_win "$(native_pid "$RUN_PID")"
        kill "$RUN_PID" 2>/dev/null; wait "$RUN_PID" 2>/dev/null
        CHAT_USED_AT_CROSS="$used"
        CHAT_POLL_STATUS="crossed"
        return 0
      fi
    else
      if [ -n "$used" ] && [ "$used" -ge "$KILL_AT" ]; then
        log "!! [chat] context threshold crossed ($used >= $KILL_AT) -> compaction"
        kill_tree_win "$(native_pid "$RUN_PID")"
        kill "$RUN_PID" 2>/dev/null; wait "$RUN_PID" 2>/dev/null
        CHAT_USED_AT_CROSS="$used"
        CHAT_POLL_STATUS="crossed"
        return 0
      fi
    fi
    # Stall watchdog: identical to sweep inner_loop (tool-in-flight exemption,
    # TOOL_STALL_TIMEOUT_S ceiling, slow-tool telemetry).
    now="$(now_s)"
    if [ -n "$tool_in_flight" ]; then
      if [ -z "$tool_since" ]; then
        tool_since="$now"
        tool_logged=0
        tool_diag_logged=0
        dbg "[chat] TOOL-IN-FLIGHT timer started (tool_since=$tool_since, session=$SID)"
      elif [ "$used" != "$last_used" ] || [ "$logsz" != "$last_logsz" ]; then
        tool_since="$now"
        tool_logged=0
        tool_diag_logged=0
        dbg "[chat] TOOL-IN-FLIGHT advanced (usage/log moved) -> restarting tool-hang timer"
      fi
      tool_telemetry "$tool_since"
      if [ $(( now - tool_since )) -ge "$TOOL_STALL_TIMEOUT_S" ]; then
        dbg "[chat] TOOL HANG after $(( now - tool_since ))s in session $SID"
        log "!! [chat] a tool call has been in flight for ${TOOL_STALL_TIMEOUT_S}s -> tool hang -> graceful shutdown"
        CHAT_POLL_STATUS="stalled"
        return 0
      fi
      last_used="$used"; last_logsz="$logsz"; last_progress="$now"
    else
      tool_since=""
      tool_logged=0
      tool_diag_logged=0
      if [ "$used" != "$last_used" ] || [ "$logsz" != "$last_logsz" ]; then
        last_used="$used"; last_logsz="$logsz"; last_progress="$now"
      fi
      if [ $(( now - last_progress )) -ge "$STALL_TIMEOUT_S" ]; then
        dbg "[chat] STALL: no progress for $(( now - last_progress ))s in session $SID"
        log "!! [chat] no observable progress for ${STALL_TIMEOUT_S}s -> model stall -> graceful shutdown"
        CHAT_POLL_STATUS="stalled"
        return 0
      fi
    fi
    sleep "$poll_s"
  done
}

# Success path: extract reply (retries), record user+assistant events (only NOW
# does the turn enter history.jsonl -> idempotent retries), bump meta, render
# history.md, append the records row, print the reply to STDOUT.
chat_finish_turn() {
  local elapsed=$(( $(now_s) - TURN_DISPATCH_S ))
  local reply_file="$WORKDIR/.chat_reply.tmp" user_file="$WORKDIR/.chat_user.tmp"
  local status="" attempt REPLY
  for attempt in 1 2 3; do
    status="$(chat_extract_reply "$SID" "$reply_file")"
    case "$status" in ok|empty) break ;; esac
    dbg "[chat] reply extraction attempt $attempt returned '$status'"
    sleep 2
  done
  if [ "$status" != "ok" ] && [ "$status" != "empty" ]; then
    local raw="(unavailable)"
    [ "$HARNESS" = "pi" ] && raw="$(pi_session_file "$SID" 2>/dev/null || echo "(not found under $PI_SESSION_DIR)")"
    [ "$HARNESS" = "opencode" ] && raw="opencode store (opencode export $SID)"
    chat_fail_turn "could not extract the assistant reply from session $SID after retries (raw transcript: $raw)"
  fi
  REPLY="$(cat "$reply_file" 2>/dev/null)"
  if [ "$status" = "empty" ]; then
    local in_before in_after
    in_before="${CHAT_SNAP_BEFORE%%|*}"
    in_after="${CHAT_SNAP_AFTER%%|*}"
    if [ -z "$in_after" ] || [ "$in_after" -le 0 ] 2>/dev/null || [ "$in_after" = "0" ]; then
      chat_fail_turn "session $SID produced no work (zero tokens, empty reply)"
    fi
    log "!! [chat] WARNING: empty assistant reply recorded (chars:0)"
  fi
  printf '%s\n' "$CHAT_USER_TEXT" >"$user_file"
  local chars_u chars_r b b_in b_cr b_cw b_hit a_in a_cr a_cw a_hit usage_json
  chars_u="$(printf '%s' "$CHAT_USER_TEXT" | wc -c | tr -d ' ')"
  chars_r="$(printf '%s' "$REPLY" | wc -c | tr -d ' ')"
  b="${CHAT_SNAP_BEFORE%%|*}"; b_in="${b:-0}"
  b="${CHAT_SNAP_AFTER%%|*}"; a_in="${b:-0}"
  b="${CHAT_SNAP_AFTER#*|}"; a_cr="${b%%|*}"; b="${b#*|}"; a_cw="${b%%|*}"; a_hit="${b##*|}"
  usage_json="$(python3 -c "import json; print(json.dumps({'input': int('${a_in:-0}'), 'cache_read': int('${a_cr:-0}'), 'cache_write': int('${a_cw:-0}')}))")"
  chat_record_event user turn="$CHAT_TURN" sid="$SID" source="$CHAT_FILE" chars="$chars_u" text="@$user_file" _ts="${CHAT_TURN_START_TS:-$(now_iso)}"
  chat_record_event assistant turn="$CHAT_TURN" sid="$SID" chars="$chars_r" usage="json:$usage_json" cache_hit_pct="${a_hit:-0}" text="@$reply_file"
  chat_meta_op bump "$CHAT_TURN" "$SID" "${a_in:-0}" "${a_cr:-0}" "${a_cw:-0}"
  chat_render_history_md "$CHAT_DIR"
  mkdir -p .chat
  printf '%s|%s|%s|%s|%s|%s|%s\n' "$CONVERSATION_ID" "$CHAT_TURN" "OK" "$elapsed" "${a_in:-0}" "${a_hit:-0}" "$SID" >>"$CHAT_RECORDS_FILE"
  rm -f "$reply_file" "$user_file" "$WORKDIR/.chat_user_input.tmp"
  log "[chat] turn complete ($(fmt_dur "$elapsed")) — reply below"
  printf '%s\n' "$REPLY"
  log "[chat] history updated: $CHAT_DIR/history.md"
}

# Read-only utility: table of conversations under .chat/.
chat_list_conversations() {
  [ -d ".chat" ] || { echo "(no conversations yet — .chat/ does not exist)"; return 0; }
  python3 - .chat <<'PY'
import sys, json, glob, os
rows = []
base = sys.argv[1]
for mp in glob.glob(os.path.join(base, "*", "meta.json")):
    try:
        d = json.load(open(mp, encoding="utf-8-sig"))
    except Exception:
        rows.append(("", "?", "", "(corrupt meta.json)", "?", ""))
        continue
    rows.append((
        str(d.get("updated_at") or ""),
        str(d.get("conversation_id") or os.path.basename(os.path.dirname(mp))),
        str(d.get("title") or ""),
        "%s/%s" % (d.get("role", ""), d.get("model", "")),
        str(d.get("turns", 0)),
        str(d.get("status", "")),
    ))
rows.sort(reverse=True)
if not rows:
    print("(no conversations yet under %s)" % base)
    raise SystemExit(0)
print("%-20s %-24s %-18s %-6s %-10s %s" % ("LAST_ACTIVITY", "ID", "TITLE", "TURNS", "STATUS", "ROLE/MODEL"))
print("%-20s %-24s %-18s %-6s %-10s %s" % ("-" * 20, "-" * 24, "-" * 18, "-" * 6, "-" * 10, "-" * 30))
for ua, cid, title, rm_, turns, st in rows:
    print("%-20s %-24s %-18s %-6s %-10s %s" % (ua[:19], cid[:24], title[:18], turns, st, rm_))
PY
}

# Read-only utility: regenerate + print history.md for --conversation-id ID.
chat_print_history_cmd() {
  CHAT_DIR=".chat/$CONVERSATION_ID"
  [ -f "$CHAT_DIR/history.jsonl" ] || die "no such conversation: $CONVERSATION_ID (check --list-conversations)"
  chat_render_history_md "$CHAT_DIR"
  cat "$CHAT_DIR/history.md"
}

# Chat mode main: load-or-init the conversation, dispatch the current user
# turn (fresh / continued / rebuilt-seeded session), drive the poll loop,
# handle compaction retries, finish or fail the turn.
run_chat_mode() {
  [ -f "$CHAT_FILE" ] || die "chat prompt file not found: $CHAT_FILE"
  [ -r "$CHAT_FILE" ] || die "chat prompt file not readable: $CHAT_FILE"
  CHAT_ACTIVE=true
  CHAT_TURN_START_TS="$(now_iso)"
  CHAT_USER_TEXT="$(cat "$CHAT_FILE")"

  CHAT_DIR=".chat/$CONVERSATION_ID"
  mkdir -p "$CHAT_DIR"

  if [ -f "$CHAT_DIR/meta.json" ]; then
    # ---- follow-up turn (or explicit attach) ----
    if [ "$CHAT_NEW" = true ]; then
      die "conversation '$CONVERSATION_ID' already exists but --new was given (refusing to attach; pick a fresh id)"
    fi
    chat_meta_get "$CHAT_DIR" || die "conversation meta corrupt: $CHAT_DIR/meta.json (v1 has no --repair; delete .chat/$CONVERSATION_ID to start over — history.jsonl still holds every recorded turn)"
    [ "$META_STATUS" = "active" ] || die "conversation $CONVERSATION_ID has status '$META_STATUS' (not active)"
    [ "$META_HARNESS" = "$HARNESS" ] || die "harness mismatch: conversation $CONVERSATION_ID is pinned to harness '$META_HARNESS' but --harness '$HARNESS' was given. Sessions cannot migrate across harnesses; start a new conversation instead."
    if [ -n "$ROLE" ] && [ "$ROLE" != "$META_ROLE" ]; then
      die "role mismatch: conversation $CONVERSATION_ID is pinned to role '$META_ROLE' (model $META_MODEL), but --role '$ROLE' was given. Switching models mid-conversation forfeits 100% of the provider prompt cache and forks memory across two sessions. Start a new conversation seeded from --print-history output instead."
    fi
    ROLE="$META_ROLE"
    resolve_role "$ROLE"   # re-resolve poll tiers/threshold from CURRENT models.json...
    [ "$MODEL_NAME" = "$META_MODEL" ] || die "model drift: models.json now resolves role '$ROLE' to $MODEL_NAME, but this conversation is pinned to $META_MODEL. Refusing to split the conversation across models."
    [ "${EFFORT:-}" = "${META_EFFORT:-}" ] || die "effort drift: conversation pinned to effort '${META_EFFORT:-default}' but models.json now says '${EFFORT:-default}'."
    KILL_AT="$META_KILL_AT"
    [ -n "$LIMIT_ARG" ] && KILL_AT="$LIMIT_ARG"   # per-run ceiling override
    if [ "$POLL_GIVEN" = true ]; then POLL_TIERS_SPEC=""; POLL_EVERY_S="$GLOBAL_POLL_EVERY_S"; POLL_TOP_S=$(( POLL_EVERY_S / 3 )); [ "$POLL_TOP_S" -lt 1 ] && POLL_TOP_S=1; POLL_LOW_S=$(( POLL_EVERY_S * 3 )); fi
    resolve_kill_threshold
    CHAT_TURN=$(( META_TURNS + 1 ))
    log "[chat] resuming conversation $CONVERSATION_ID (turn $CHAT_TURN, role=$ROLE, model=$MODEL_NAME, pinned since $META_CREATED_AT)"
  else
    # ---- turn 1: new conversation ----
    if [ -z "$ROLE" ]; then
      ROLE="$(python3 -c "import json; print(json.load(open('$ROLE_FILE',encoding='utf-8-sig')).get('default_role','standard'))" 2>/dev/null || echo standard)"
      log "[chat] no --role given; pinning models.json default_role '$ROLE'"
    fi
    KILL_AT=""; KILL_PCT=90; WINDOW_TOTAL=""; TIER30=0; TIER70=0; POLL_TIERS_SPEC=""
    POLL_EVERY_S="$GLOBAL_POLL_EVERY_S"
    POLL_TOP_S=$(( POLL_EVERY_S / 3 )); [ "$POLL_TOP_S" -lt 1 ] && POLL_TOP_S=1
    POLL_LOW_S=$(( POLL_EVERY_S * 3 ))
    resolve_role "$ROLE"
    [ -n "$LIMIT_ARG" ] && KILL_AT="$LIMIT_ARG"
    if [ "$POLL_GIVEN" = true ]; then POLL_TIERS_SPEC=""; fi
    resolve_kill_threshold
    chat_build_preamble
    chat_init_conversation
    CHAT_TURN=1
    log "[chat] opened conversation $CONVERSATION_ID (turn 1, role=$ROLE, model=$MODEL_NAME, kill_at=$KILL_AT)"
  fi

  SUPERVISOR_MODEL="${SUPERVISOR_MODEL:-$MODEL_NAME}"
  export SUPERVISOR_MODEL
  chat_preflight_prompt

  # Session selection for THIS turn.
  SID=""
  if [ "$COMPACT_NOW" = true ]; then
    if [ "$CHAT_TURN" = 1 ] || [ -z "$META_ACTIVE_SID" ]; then
      log "[chat] --compact-now: nothing to compact yet (no prior session)"
    elif chat_session_alive "$META_ACTIVE_SID"; then
      SID="$META_ACTIVE_SID"
      local snap; snap="$(chat_usage_snapshot "$SID")"
      CHAT_USED_AT_CROSS="${snap%%|*}"
      log "[chat] --compact-now requested -> forcing compaction before this turn"
      CHAT_COMPACTIONS_THIS_TURN=$(( CHAT_COMPACTIONS_THIS_TURN + 1 ))
      chat_compact "$CHAT_USED_AT_CROSS"
    else
      log "[chat] --compact-now: active session is gone; this turn will rebuild from summary + recent turns"
      SID=""
    fi
  elif [ -n "$META_ACTIVE_SID" ]; then
    if chat_session_alive "$META_ACTIVE_SID"; then
      SID="$META_ACTIVE_SID"
    else
      log "!! [chat] active session $META_ACTIVE_SID is no longer resumable (transcript pruned?) -> rebuilding from summary.md + recent turns (degraded memory)"
    fi
  fi

  # User text also staged through a file (byte-stable input for seed building).
  printf '%s\n' "$CHAT_USER_TEXT" >"$WORKDIR/.chat_user_input.tmp"

  # ---- dispatch loop (compaction retries re-enter here) ----
  while :; do
    if [ "$CHAT_COMPACTIONS_THIS_TURN" -ge 3 ]; then
      chat_fail_turn "compacted $CHAT_COMPACTIONS_THIS_TURN times for the same turn without completing it — aborting (raise/remove --limit or shorten the prompt)"
    fi
    local msg
    if [ -z "$SID" ]; then
      # New session needed: turn 1 gets preamble+question; rebuilds get the seed.
      if [ "$CHAT_TURN" = 1 ]; then
        msg="$CHAT_PREAMBLE
---

$CHAT_USER_TEXT"
      else
        local seed_file="$WORKDIR/.chat_seed.tmp"
        chat_build_seed "$seed_file" "$WORKDIR/.chat_user_input.tmp"
        msg="$(cat "$seed_file")"
        rm -f "$seed_file"
      fi
      if ! chat_spawn_and_discover "$msg"; then
        chat_fail_turn "could not discover a session id within ${SESSION_DISCOVERY_TIMEOUT_S}s (agent CLI appears wedged at startup; see _run.log)"
      fi
      chat_meta_op set-active "$SID" primary "$CHAT_TURN"
      if [ -n "$CHAT_PENDING_COMPACTION" ]; then
        local sum_chars
        sum_chars="$(wc -c <"$CHAT_DIR/summary.md" 2>/dev/null | tr -d ' ')"
        [ -n "$sum_chars" ] || sum_chars=0
        chat_record_event compaction turn="$CHAT_TURN" old_sid="$CHAT_PENDING_COMPACTION" new_sid="$SID" summary_chars="$sum_chars" tail_turns="$CHAT_SEED_TAIL_TURNS"
        log "[chat] compacted: session $CHAT_PENDING_COMPACTION -> $SID (summary ${sum_chars}B, tail $CHAT_SEED_TAIL_TURNS turns)"
        CHAT_PENDING_COMPACTION=""
      elif [ "$CHAT_TURN" != 1 ]; then
        chat_record_event session_rebuild turn="$CHAT_TURN" old_sid="$META_ACTIVE_SID" new_sid="$SID" reason="active session lost; seeded from summary + recent turns"
      fi
    else
      chat_spawn_continue "$SID" "$CHAT_USER_TEXT"
    fi

    CHAT_SNAP_BEFORE="$(chat_usage_snapshot "$SID")"
    TURN_DISPATCH_S="$(now_s)"
    log "[chat] conversation $CONVERSATION_ID (turn $CHAT_TURN, role=$ROLE, model=$MODEL_NAME, sid=$SID)"

    chat_poll_loop
    case "$CHAT_POLL_STATUS" in
      ok)
        CHAT_SNAP_AFTER="$(chat_usage_snapshot "$SID")"
        chat_finish_turn
        exit 0 ;;
      err)
        log "!! [chat] persistent model error: $CHAT_LAST_ERR"
        log "    conversation untouched — re-run the same --chat command later to retry this turn (idempotent)"
        chat_record_event error turn="$CHAT_TURN" sid="$SID" message="$CHAT_LAST_ERR" action="graceful_stop_rerun_to_retry"
        [ -d ".chat" ] && printf '%s|%s|%s|%s|%s|%s|%s\n' "$CONVERSATION_ID" "$CHAT_TURN" "FAILED" "0" "" "" "$SID" >>"$CHAT_RECORDS_FILE" 2>/dev/null || true
        exit 1 ;;
      crossed)
        CHAT_COMPACTIONS_THIS_TURN=$(( CHAT_COMPACTIONS_THIS_TURN + 1 ))
        chat_compact "$CHAT_USED_AT_CROSS" || chat_fail_turn "compaction failed"
        continue ;;
      stalled)
        chat_graceful_shutdown ;;
      *)
        chat_fail_turn "unknown poll status '$CHAT_POLL_STATUS'" ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# planner mode (Step 2): design plans -> prompts JSON -> rewrite run_sequential.conf
# (ported from design_documents/design_plans/run_cursor_sweep.sh)
# ---------------------------------------------------------------------------

planner_log() {
  local line="[$(date '+%H:%M:%S')] $*"
  printf '%s\n' "$line" >>"$PLANNER_LOG_FILE" 2>/dev/null || true
  emit_console "$line"
}

planner_is_done() {  # $1 module
  [ -f "$PLANNER_RESULTS_FILE" ] || return 1
  grep -q "^${1}|DONE|" "$PLANNER_RESULTS_FILE" 2>/dev/null
}

planner_mark_result() {  # $1 module  $2 status
  local tmp
  tmp="$(mktemp)"
  if [ -f "$PLANNER_RESULTS_FILE" ]; then
    grep -v "^${1}|" "$PLANNER_RESULTS_FILE" >"$tmp" 2>/dev/null || true
  fi
  echo "${1}|${2}|$(date '+%Y-%m-%dT%H:%M:%S')" >>"$tmp"
  mv "$tmp" "$PLANNER_RESULTS_FILE"
}

planner_should_skip() {  # $1 module  $2 out_prompts
  [ "$FORCE" = true ] && return 1
  if planner_is_done "$1" && [ -f "$2" ]; then
    return 0
  fi
  return 1
}

# Default output path for a module when the conf line omits it.
# Prefer a repo-relative path so run_sequential.conf stays portable.
planner_default_out() {  # $1 module_id
  if [ -n "$PLANNER_OUT_DIR" ]; then
    echo "${PLANNER_OUT_DIR%/}/prompts_${1}.json"
  else
    echo ".run_sweep/prompts_${1}.json"
  fi
}

load_planner_conf() {
  [ -f "$PLANNER_CONF" ] || die "planner conf not found: $PLANNER_CONF (create it or pass --planner FILE)"
  local line cleaned module plan out role kmode m
  PLANNER=()
  while IFS= read -r line || [ -n "$line" ]; do
    # Strip UTF-8 BOM (PowerShell Set-Content often prepends it) and CR.
    line="${line#$'\xEF\xBB\xBF'}"
    line="${line%$'\r'}"
    cleaned="${line%%#*}"
    cleaned="$(printf '%s\n' "$cleaned" | sed 's/[[:space:]]*$//; s/^[[:space:]]*//')"
    [ -n "$cleaned" ] || continue
    case "$cleaned" in
      *:*) : ;;
      *) die "bad line in planner conf '$PLANNER_CONF': '$line' (expected MODULE_ID:path/to/design_plan.md[:OUT[:ROLE[:KILL_MODE]]])" ;;
    esac
    IFS=':' read -r module plan out role kmode <<<"$cleaned"
    if [ -z "$module" ] || [ -z "$plan" ]; then
      die "bad line in planner conf '$PLANNER_CONF': '$line' (expected MODULE_ID:path/to/design_plan.md[:OUT[:ROLE[:KILL_MODE]]])"
    fi
    case "$module" in
      *[!A-Za-z0-9_-]*) die "bad module id '$module' in planner conf '$PLANNER_CONF' (allowed: [A-Za-z0-9_-], no spaces)" ;;
    esac
    if [ -n "$role" ]; then
      case "$role" in
        *[!A-Za-z0-9_-]*) die "bad role '$role' in planner conf '$PLANNER_CONF' (allowed: [A-Za-z0-9_-], no spaces)" ;;
      esac
    fi
    if [ -n "$kmode" ] && [ "$kmode" != "budget" ] && [ "$kmode" != "compact" ]; then
      die "bad kill-mode '$kmode' in planner conf '$PLANNER_CONF' (expected budget|compact)"
    fi
    [ -n "$out" ] || out="$(planner_default_out "$module")"
    for m in "${PLANNER[@]}"; do
      [ "${m%%:*}" = "$module" ] && die "duplicate module id '$module' in planner conf '$PLANNER_CONF'"
    done
    PLANNER+=("$module:$plan:$out:$role:$kmode")
  done <"$PLANNER_CONF"
  [ "${#PLANNER[@]}" -gt 0 ] || die "planner conf '$PLANNER_CONF' contains no design plans"
  planner_log "loaded ${#PLANNER[@]} design plans from $PLANNER_CONF"
}

# Validate a prompts JSON written by the planner. $1=path $2=expected module id.
# Prints the number of steps on success; errors go to stderr.
validate_prompts_json() {
  python3 - "$1" "$2" "$ROLE_FILE" <<'PY'
import json, sys
path, expected, models_path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    data = json.load(open(path, encoding="utf-8-sig"))
except FileNotFoundError:
    print(f"output file not written: {path}", file=sys.stderr); sys.exit(1)
except Exception as e:
    print(f"invalid JSON: {e}", file=sys.stderr); sys.exit(1)
if data.get("module") != expected:
    print(f"module mismatch: file has {data.get('module')!r}, expected {expected!r}", file=sys.stderr); sys.exit(1)
prompts = data.get("prompts")
if not isinstance(prompts, list) or not prompts:
    print("prompts must be a non-empty array", file=sys.stderr); sys.exit(1)
try:
    ladder = set(json.load(open(models_path, encoding="utf-8-sig")).get("implementation_ladder") or [])
except Exception:
    ladder = {"mechanical", "standard", "complex", "critical"}
if not ladder:
    ladder = {"mechanical", "standard", "complex", "critical"}
for i, p in enumerate(prompts):
    need = ("step", "title", "role", "previous_implementation_summary", "prompt_text")
    for k in need:
        if k not in p:
            print(f"prompts[{i}] missing {k}", file=sys.stderr); sys.exit(1)
    if p.get("step") != i + 1:
        print(f"prompts[{i}].step must be {i+1}, got {p.get('step')!r}", file=sys.stderr); sys.exit(1)
    role = p.get("role")
    if role not in ladder:
        print(f"prompts[{i}].role {role!r} not in implementation_ladder {sorted(ladder)}", file=sys.stderr); sys.exit(1)
    if not str(p.get("prompt_text") or "").strip():
        print(f"prompts[{i}].prompt_text is empty", file=sys.stderr); sys.exit(1)
last = prompts[-1]
if "next_step" in last and last["next_step"] is not None:
    print("last prompt next_step must be null", file=sys.stderr); sys.exit(1)
print(len(prompts))
PY
}

build_planner_prompt() {  # $1 module  $2 design_plan  $3 out_prompts  $4 dest_file
  local module="$1" plan="$2" out="$3" dest="$4" ladder
  [ -n "$dest" ] || die "build_planner_prompt: dest file argument required"
  [ -f "$ROLE_FILE" ] || die "models.json missing: $ROLE_FILE"
  # Inject the REAL implementation ladder from models.json so the brief can
  # never drift from what validate_prompts_json enforces.
  ladder="$(python3 -c "import json,sys; print(','.join(json.load(open(sys.argv[1],encoding='utf-8-sig')).get('implementation_ladder') or []))" "$ROLE_FILE" 2>/dev/null || echo '')"
  [ -n "$ladder" ] || ladder='mechanical,standard,complex,critical'
  # Brief + schema live in this function (not on disk). A from-scratch run
  # must not require planner_brief.md.tmpl or any prompts_*.json as input.
  # Write the rendered brief to $dest — never print it to stdout.
  # Keep PROMPTS_SCHEMA in sync with validate_prompts_json above.
  if ! python3 - "$module" "$plan" "$out" "$ROLE_FILE" "$dest" "$ladder" <<'PY'
import sys
module, plan, out, models, dest, ladder_csv = sys.argv[1:7]
LADDER_MD = " | ".join(ladder_csv.split(","))
# Authoritative prompts JSON schema. Injected into the planner brief so the
# planner never needs a prompts_*.json — those files are outputs of --planner.
PROMPTS_SCHEMA = """The file you write is an OUTPUT of this run. Do not read any existing
`prompts_*.json` (including `prompts_M0.json` or `prompts_example.json`) as a
template — those files are produced by this planner, not consumed by it.

UTF-8 JSON object. Extra keys are allowed but ignored by the driver.

Root (required):
- `module` (string): MUST equal the module id given in this brief.
- `prompts` (array): MUST be a non-empty array of step objects.

Root (recommended; used in the implementation handout):
- `module_name` (string): short human name from the design-plan title.
- `design_plan` (string): the design-plan path given in this brief.
- `design_plan_directory` (string): directory containing that plan.
- `blueprint_baseline` (string): short pointer to master-blueprint sections, or "".

Each `prompts[i]` object MUST contain:
- `step` (integer): 1-based and contiguous (`prompts[0].step == 1`, then 2, 3, …).
- `title` (string): short title for the step.
- `role` (string): exactly one of the `implementation_ladder` roles in
  `{MODELS_JSON}` ({LADDER}). Do not put model ids here.
- `previous_implementation_summary` (string): step 1 starts with "None." and
  states series context. Later steps say what prior steps left on disk.
- `prompt_text` (string): non-empty complete agent brief (what to read, what
  to create/edit, invariants, exact verify commands named by the design plan).
- `next_step` (integer or null): `i+2` for non-last steps; MUST be `null` on
  the last step if the key is present.

The driver rejects the file if JSON is invalid, `module` mismatches, `prompts`
is missing/empty, a required field is absent, `step` is not contiguous, `role`
is not on the ladder, `prompt_text` is blank, or the last `next_step` is not null.
"""
PLANNER_BRIEF_TEMPLATE = r"""You are the PLANNER agent for this repository (models.json role: planner).

Your ONLY job for this run is to read ONE design plan and write ONE prompts JSON
file that the implementation driver (`run_sweep.sh --sequence`) will consume
later. Do not implement product code. Do not edit unrelated files.

## Inputs (authoritative)

- Design plan (READ IN FULL): `{DESIGN_PLAN}`
- Output path (WRITE THIS FILE, overwrite if present): `{OUT_PROMPTS}`
- Module id: `{MODULE_ID}`
- Models / roles file (READ): `{MODELS_JSON}`

`{OUT_PROMPTS}` does not exist yet and MUST NOT be treated as an input. Do not
read `prompts_M0.json`, `prompts_example.json`, or any other `prompts_*.json`
for shape. The schema below is complete.

## Prompts JSON schema (authoritative)

{PROMPTS_SCHEMA}

## What to produce

Write valid UTF-8 JSON to `{OUT_PROMPTS}` with this shape:

```json
{
  "module": "{MODULE_ID}",
  "module_name": "<short human name from the design plan title>",
  "design_plan": "{DESIGN_PLAN}",
  "design_plan_directory": "<directory containing the design plan>",
  "blueprint_baseline": "<optional short pointer to master blueprint sections this plan rests on, or empty string>",
  "prompts": [
    {
      "step": 1,
      "title": "<short title>",
      "role": "<one of: {LADDER}>",
      "previous_implementation_summary": "None. ...",
      "prompt_text": "<full agent brief for this step>",
      "next_step": 2
    }
  ]
}
```

Rules for `prompts[]`:

1. Split the design plan into an ordered sequence of implementation tasks.
   Prefer fewer, self-contained steps over tiny micro-tasks, but keep each step
   small enough that one agent session can finish it (typically one coherent
   slice of the plan: a subsystem, a user-story group, or an acceptance cluster).
2. `step` is 1-based and contiguous. The last entry has `"next_step": null`.
3. Every entry MUST include `"role"` — exactly one of the implementation
   ladder roles in `{MODELS_JSON}`: {LADDER}. Assign by difficulty: earlier
   (lighter) roles for easy steps, later (stronger) roles for hard steps;
   when unsure between two suitable roles, prefer the lighter one.
4. `previous_implementation_summary` for step 1 starts with "None." and explains
   the series context. Later steps briefly state what prior steps left on disk.
5. `prompt_text` must be a complete agent brief: what to read first, what to
   create/edit, invariants, and exact verify commands when the design plan
   names them. Do not invent requirements that are not in the design plan.
6. Do not put model ids in the JSON. Roles are data; model ids live only in
   `{MODELS_JSON}`.

## Process

1. Read `{DESIGN_PLAN}` thoroughly (do not skim).
2. Skim the repo only as needed to make steps realistic (existing paths, prior
   modules). Prefer Read / Glob / Grep. Do not start implementing.
3. Read `{MODELS_JSON}` for the ladder and role descriptions.
4. Follow the schema in this brief. Do not open any `prompts_*.json`.
5. Build `{OUT_PROMPTS}` INCREMENTALLY with MANY SMALL file operations -
   NEVER one giant write. Long single-shot generations get cut off by the
   provider mid-stream; many small writes are robust:
   a. First Write a minimal skeleton to `{OUT_PROMPTS}`:
      {{"module": "{MODULE_ID}", "prompts": [ __STEP__ ]}}
   b. For each planned step, Edit the file replacing the `__STEP__`
      placeholder with that step's complete JSON object followed by a fresh
      placeholder: <step object>, __STEP__
   c. Keep every individual tool call SMALL (a few dozen lines). Split a long
      `prompt_text` across two edits (placeholder, then fill) if needed.
   d. When all steps are in, Edit away the trailing ", __STEP__" placeholder,
      make sure the LAST step has "next_step": null, and verify the file
      parses as JSON (e.g. python3 -c "import json; json.load(open('{OUT_PROMPTS}'))").
      Fix any parse error with small targeted edits.
6. Turn economy: keep every assistant reply SHORT - one or two sentences of
   status plus ONE small tool call. Never narrate the whole plan up front;
   never batch several large edits into a single reply.
7. When done, print a one-line summary: module id, number of steps, and a count
   of roles used (e.g. `standard=4 complex=2`). Then stop.

## Done criteria

- `{OUT_PROMPTS}` exists
- JSON parses
- `module` equals `{MODULE_ID}`
- every prompt has `step`, `title`, `role`, `previous_implementation_summary`,
  `prompt_text`, `next_step`
- every `role` is one of the implementation_ladder roles in `{MODELS_JSON}`
- steps are contiguous starting at 1
"""
text = PLANNER_BRIEF_TEMPLATE
repl = {
    "{MODULE_ID}": module,
    "{DESIGN_PLAN}": plan,
    "{OUT_PROMPTS}": out,
    "{MODELS_JSON}": models,
    "{PROMPTS_SCHEMA}": PROMPTS_SCHEMA,
    "{LADDER}": LADDER_MD,
}
missing = [k for k in repl if k not in text]
if missing:
    print("planner template missing placeholder(s): " + ", ".join(missing), file=sys.stderr)
    sys.exit(1)
for k, v in repl.items():
    text = text.replace(k, v)
if plan not in text:
    print(f"rendered planner prompt is missing design plan path {plan!r}", file=sys.stderr)
    sys.exit(1)
if not text.strip():
    print("rendered planner prompt is empty", file=sys.stderr)
    sys.exit(1)
open(dest, "w", encoding="utf-8", newline="\n").write(text)
PY
  then
    die "failed to render planner brief to $dest"
  fi
  [ -s "$dest" ] || die "failed to render planner brief to $dest (empty file)"
}

# Spawn one planner agent and wait until it exits. Returns 0 on success.
# Includes premature-stop nudges: if the agent exits cleanly with no transcript
# error but the output prompts JSON is missing/unparseable, re-invoke the SAME
# session with a continue prompt (MAX_CONTINUE_NUDGES per plan).
run_planner_agent_once() {  # $1 prompt_file  $2 expected_out_prompts
  local prompt_file="$1" out="$2" rc=0
  local used logsz last_used last_logsz last_progress session_err cont_prompt valid
  CONTINUE_NUDGE_TS=""     # rolling continue-nudge rate window (per attempt)
  CONTINUE_NUDGES_TOTAL=0
  [ -s "$prompt_file" ] || { log "!! planner prompt file missing or empty: $prompt_file"; return 1; }
  log " spawn planner session (model=$MODEL_NAME)..."
  mkdir -p "$PI_SESSION_DIR"
  start_ms="$(now_ms)"
  ( cd "$WORKDIR" && run_agent_cli "$(cat "$prompt_file")" ) \
    >"$WORKDIR/_run.log" 2>&1 < /dev/null &
  RUN_PID=$!

  SID=""
  SID_DISC_START="$(now_s)"
  while [ $(( $(now_s) - SID_DISC_START )) -lt "$SESSION_DISCOVERY_TIMEOUT_S" ]; do
    if [ "$HARNESS" = "pi" ]; then
      SID="$(pi_sid_from_log)"
      [ -n "$SID" ] && break
    else
      SID="$(opencode_session_after "$start_ms" "$THIS_PROJECT")"
      [ -n "$SID" ] && break
    fi
    kill -0 "$RUN_PID" 2>/dev/null || break
    sleep 1
  done
  [ -n "$SID" ] || SID="$(pi_newest_session)"
  if [ -z "$SID" ]; then
    log "!! planner: could not discover a session id in ${SESSION_DISCOVERY_TIMEOUT_S}s (see _run.log)"
    kill_tree_win "$(native_pid "$RUN_PID")" 2>/dev/null
    kill "$RUN_PID" 2>/dev/null; wait "$RUN_PID" 2>/dev/null
    RUN_PID=""
    return 1
  fi
  log " planner session: $SID"

  last_used=""
  last_logsz=-1
  last_progress="$(now_s)"
  while :; do
    # Premature-stop guard: clean exit but output prompts JSON missing/broken.
    if ! kill -0 "$RUN_PID" 2>/dev/null; then
      valid=""
      [ -f "$out" ] && valid="$(python3 -c "import json,sys; json.load(open(sys.argv[1],encoding='utf-8-sig'))" "$out" 2>/dev/null && echo 1)"
      session_err="$(session_errored "$SID")"
      if [ -z "$session_err" ] && [ -z "$valid" ] \
         && continue_nudge_try; then
        log "!! planner premature stop detected ($out missing/unparseable) -> sending 'continue' to the SAME session ($(continue_nudge_window_used)/$MAX_CONTINUE_NUDGES per ${CONTINUE_NUDGE_WINDOW_S}s, total ${CONTINUE_NUDGES_TOTAL}/$CONTINUE_MAX_TOTAL)"
        dbg "planner premature-stop nudge: sid=$SID window_used=$(continue_nudge_window_used)/$MAX_CONTINUE_NUDGES total=${CONTINUE_NUDGES_TOTAL:-0}/$CONTINUE_MAX_TOTAL"
        sleep 2
        cont_prompt="Your previous turn was cut off before you finished. Do NOT restart from scratch and do NOT restate your plan: CONTINUE exactly where you stopped. Finish writing the complete prompts JSON to '$out' per your original brief (schema included there), validate it parses, then stop."
        ( cd "$WORKDIR" && run_agent_cli --session "$SID" "$cont_prompt" ) \
          >"$WORKDIR/_run.log" 2>&1 < /dev/null &
        RUN_PID=$!
        last_used=""; last_logsz=-1; last_progress="$(now_s)"
        continue
      fi
      break
    fi
    used="$(usage_tokens "$SID")"
    logsz="$(wc -c <"$WORKDIR/_run.log" 2>/dev/null || echo 0)"
    if [ -n "$used" ] && [ "$used" -ge 0 ] 2>/dev/null && [ -n "$WINDOW_TOTAL" ]; then
      pct=$(( used * 100 / WINDOW_TOTAL ))
      log " planner usage≈${used}/${WINDOW_TOTAL} (${pct}%)"
      if [ -n "$KILL_AT" ] && [ "$used" -ge "$KILL_AT" ]; then
        log "!! planner hit kill threshold ${KILL_AT}; stopping (write what you can next run with --force)"
        kill_tree_win "$(native_pid "$RUN_PID")" 2>/dev/null
        kill "$RUN_PID" 2>/dev/null; wait "$RUN_PID" 2>/dev/null
        RUN_PID=""
        return 1
      fi
    else
      log " planner running (log=${logsz}B)"
    fi
    session_err="$(session_errored "$SID")"
    if [ -n "$session_err" ]; then
      log "!! planner model error: $session_err"
      kill_tree_win "$(native_pid "$RUN_PID")" 2>/dev/null
      kill "$RUN_PID" 2>/dev/null; wait "$RUN_PID" 2>/dev/null
      RUN_PID=""
      # Field evidence on stream-fragile providers: a --resume after a dropped
      # stream re-errors within seconds with ZERO token growth (wedged), and
      # long single generations get killed mid-flight. Progress must live on
      # DISK (incremental writes to $out), not in the session - so log
      # diagnostics, fail this attempt fast, and let run_one_plan restart
      # FRESH with a recovery brief pointing at the partial output file.
      log "!! planner stream dropped mid-generation (used≈${used:-?}); partial out: $(wc -c <"$out" 2>/dev/null || echo 0)B"
      dbg "planner drop tail: $(tail -c 300 "$WORKDIR/_run.log" 2>/dev/null | tr '\n' ' ')"
      return 1
    fi
    if [ "$used" = "$last_used" ] && [ "$logsz" = "$last_logsz" ]; then
      if [ $(( $(now_s) - last_progress )) -ge "$STALL_TIMEOUT_S" ]; then
        log "!! planner stalled for ${STALL_TIMEOUT_S}s; killing"
        kill_tree_win "$(native_pid "$RUN_PID")" 2>/dev/null
        kill "$RUN_PID" 2>/dev/null; wait "$RUN_PID" 2>/dev/null
        RUN_PID=""
        return 1
      fi
    else
      last_progress="$(now_s)"
      last_used="$used"
      last_logsz="$logsz"
    fi
    sleep "${POLL_EVERY_S:-10}"
  done
  if [ -n "${RUN_PID:-}" ]; then
    wait "$RUN_PID" 2>/dev/null || rc=$?
  fi
  RUN_PID=""
  err="$(session_errored "$SID")"
  if [ -n "$err" ]; then
    log "!! planner session error: $err"
    return 1
  fi
  return 0
}

run_one_plan() {  # $1 module  $2 design_plan  $3 out  $4 fallback_role  $5 kmode
  local module="$1" plan="$2" out="$3" role="$4" kmode="$5" nsteps verr prompt_snapshot existing_plan mf attempt_prompt
  planner_log "============================================================"
  planner_log "PLAN $module  starting  ($(date '+%Y-%m-%d %H:%M:%S'))"
  planner_log "  design_plan=$plan"
  planner_log "  out=$out"
  planner_log "============================================================"

  [ -f "$plan" ] || die "design plan missing: $plan"
  mkdir -p "$(dirname "$out")"

  if [ "$PLANNER_DRY_RUN" = true ]; then
    planner_log "DRY-RUN: would spawn planner for $module -> $out"
    return 0
  fi

  if [ -f "$out" ] && [ "$FORCE" != true ]; then
    if nsteps="$(validate_prompts_json "$out" "$module" 2>/dev/null)"; then
      existing_plan="$(python3 -c "import json; print(json.load(open('$out',encoding='utf-8-sig')).get('design_plan','') or '')" 2>/dev/null || true)"
      if [ -n "$existing_plan" ] && [ "$existing_plan" != "$plan" ]; then
        planner_log "existing $out is for design_plan='$existing_plan', expected '$plan' — re-planning (use --force to skip this check)"
      else
        planner_log "existing valid prompts for $module ($nsteps steps) — skipping (use --force to overwrite)"
        planner_mark_result "$module" "DONE"
        return 0
      fi
    fi
  fi

  # Resolve the planner role for this agent (models.json planner_role / "planner").
  PLANNER_ROLE_NAME="$(python3 -c "import json; print(json.load(open('$ROLE_FILE',encoding='utf-8-sig')).get('planner_role','planner'))" 2>/dev/null || echo planner)"
  ROLE="$PLANNER_ROLE_NAME"
  KILL_AT=""
  KILL_PCT=90
  WINDOW_TOTAL=""
  TIER30=0
  TIER70=0
  POLL_TIERS_SPEC=""
  POLL_EVERY_S="$GLOBAL_POLL_EVERY_S"
  POLL_TOP_S=$(( POLL_EVERY_S / 3 )); [ "$POLL_TOP_S" -lt 1 ] && POLL_TOP_S=1
  POLL_LOW_S=$(( POLL_EVERY_S * 3 ))
  resolve_role "$ROLE"
  if [ -n "$LIMIT_ARG" ]; then
    KILL_AT="$LIMIT_ARG"
  fi
  resolve_kill_threshold

  prompt_snapshot="$WORKDIR/.planner_prompt_${module}.md"
  build_planner_prompt "$module" "$plan" "$out" "$prompt_snapshot"
  if ! grep -q -F -- "$plan" "$prompt_snapshot"; then
    die "planner prompt build failed: design plan path '$plan' missing from $prompt_snapshot"
  fi
  planner_log "  planner prompt saved: $prompt_snapshot ($(wc -c <"$prompt_snapshot" | tr -d ' ') bytes)"

  # Retry loop with the same policy as the sweep's retry_or_shutdown: a session
  # that ends in a model/API error (e.g. transient "Stream ended without
  # finish_reason"), or that produced no valid output, is NEVER a completion.
  # Retry with a FRESH session after MODEL_FAILURE_BACKOFF_S, up to
  # MAX_MODEL_FAILURES consecutive failures, before marking the plan FAILED.
  mf=0
  while :; do
    mf=$((mf + 1))
    planner_log "  planner attempt $mf/$MAX_MODEL_FAILURES..."
    # Recovery mode (attempt >= 2 with a partial output on disk): point a
    # FRESH session at the partial file instead of the empty skeleton. The
    # disk file is the checkpoint - sessions are disposable on providers that
    # kill long streams.
    attempt_prompt="$prompt_snapshot"
    if [ "$mf" -gt 1 ] && [ -s "$out" ]; then
      attempt_prompt="$WORKDIR/.planner_prompt_${module}_resume.md"
      {
        cat "$prompt_snapshot"
        printf '\n\n## RESUME NOTE (this is a continuation attempt)\n\nA previous attempt was writing `%s` incrementally but its stream died mid-way. That PARTIAL file exists RIGHT NOW. Read it FIRST, verify it parses as JSON (fix small syntax errors with small edits if needed), then CONTINUE the incremental protocol from wherever it stopped: do NOT redo steps already present, do NOT start from the empty skeleton, do NOT rewrite existing steps.\n' "$out"
      } >"$attempt_prompt"
      planner_log "  recovery brief: $attempt_prompt (partial out=$(wc -c <"$out" | tr -d ' ')B)"
    fi
    run_planner_agent_once "$attempt_prompt" "$out" || true

    verr="$(mktemp)"
    if nsteps="$(validate_prompts_json "$out" "$module" 2>"$verr")"; then
      rm -f "$verr"
      break
    fi
    planner_log "PLAN $module attempt $mf produced no valid prompts JSON ($out — that path is an output of this step, not an input)"
    if [ -s "$verr" ]; then
      planner_log "  validator: $(tr '\n' ' ' <"$verr")"
    fi
    rm -f "$verr"
    if [ "$mf" -ge "$MAX_MODEL_FAILURES" ]; then
      planner_log "PLAN $module FAILED after $MAX_MODEL_FAILURES consecutive failed attempts"
      planner_mark_result "$module" "FAILED"
      return 1
    fi
    planner_log "!! attempt $mf failed -> retrying with a FRESH session in ${MODEL_FAILURE_BACKOFF_S}s"
    sleep "$MODEL_FAILURE_BACKOFF_S"
  done

  planner_log "PLAN $module DONE — wrote $out ($nsteps steps)"
  planner_mark_result "$module" "DONE"
  return 0
}

# Rewrite run_sequential.conf from the planner's PLANNER[] list (all entries,
# including ones skipped as already DONE), preserving a short header.
write_sequential_conf_from_plans() {
  local tmp e module plan out role kmode rest
  tmp="$(mktemp)"
  {
    echo "# run_sequential.conf - generated by run_sweep.sh --planner"
    echo "# Source: $PLANNER_CONF"
    echo "# Generated: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "# Syntax: MODULE_ID:path/to/prompts.json[:ROLE[:KILL_MODE]]"
    echo "# Per-step roles live in each prompts JSON (prompts[i].role)."
    echo "# The optional ROLE here is only a module-level fallback."
    echo "#"
    for e in "${PLANNER[@]}"; do
      module="${e%%:*}"
      rest="${e#*:}"
      plan="${rest%%:*}"
      rest="${rest#*:}"
      out="${rest%%:*}"
      rest="${rest#*:}"
      role="${rest%%:*}"
      rest="${rest#*:}"
      kmode="${rest%%:*}"
      if [ -n "$role" ] && [ -n "$kmode" ]; then
        echo "${module}:${out}:${role}:${kmode}"
      elif [ -n "$role" ]; then
        echo "${module}:${out}:${role}"
      elif [ -n "$kmode" ]; then
        echo "${module}:${out}::${kmode}"
      else
        echo "${module}:${out}"
      fi
    done
  } >"$tmp"
  mv "$tmp" "$SEQUENCE_CONF"
  planner_log "updated sequence conf: $SEQUENCE_CONF (${#PLANNER[@]} modules)"
}

print_planner_summary() {
  log "============================================================"
  log "PLANNER RUN SUMMARY  ($(date '+%Y-%m-%d %H:%M:%S'))"
  log "============================================================"
  if [ -f "$PLANNER_RESULTS_FILE" ]; then
    printf '%-8s %-10s %s\n' "MODULE" "STATUS" "AT"
    printf '%-8s %-10s %s\n' "------" "------" "--"
    while IFS='|' read -r m s at; do
      [ -n "$m" ] && printf '%-8s %-10s %s\n' "$m" "$s" "$at"
    done <"$PLANNER_RESULTS_FILE"
  else
    log "(no results recorded)"
  fi
  log "Sequence conf: $SEQUENCE_CONF"
  log "Details: $PLANNER_LOG_FILE"
}

run_planner() {
  local started=false module plan out role kmode rest rc e m
  [ -f "$ROLE_FILE" ] || die "models.json missing: $ROLE_FILE"
  if [ -n "$FROM" ]; then
    local found=false
    for e in "${PLANNER[@]}"; do
      m="${e%%:*}"
      [ "$m" = "$FROM" ] && found=true
    done
    [ "$found" = true ] || die "unknown --from module '$FROM' (one of: ${PLANNER[*]%%:*})"
  else
    FROM="${PLANNER[0]%%:*}"
    planner_log "no --from given; starting from the first design plan: $FROM"
  fi

  planner_log "Planner driver starting. Modules: ${PLANNER[*]%%:*}"
  planner_log "planner_role=$PLANNER_ROLE_NAME  harness=$HARNESS  model=${MODEL_NAME:-default}  from=$FROM  force=$FORCE  dry_run=$PLANNER_DRY_RUN  out_dir=${PLANNER_OUT_DIR:-.run_sweep}"
  planner_log "Will rewrite sequence conf: $SEQUENCE_CONF"

  if [ "$PLANNER_DRY_RUN" = true ]; then
    for e in "${PLANNER[@]}"; do
      module="${e%%:*}"
      rest="${e#*:}"
      plan="${rest%%:*}"
      rest="${rest#*:}"
      out="${rest%%:*}"
      planner_log "DRY-RUN $module: $plan -> $out"
    done
    write_sequential_conf_from_plans
    print_planner_summary
    planner_log "DRY-RUN complete (no agents spawned; sequence conf rewritten from conf list)."
    return 0
  fi

  # Ensure the agent CLI is available before the first spawn.
  if [ -z "${PI_TEST_CMD:-}" ]; then
    if [ "$HARNESS" = "pi" ]; then
      command -v pi >/dev/null 2>&1 || die "pi CLI not found on PATH (required by --planner with --harness pi)"
    else
      command -v opencode >/dev/null 2>&1 || die "opencode CLI not found on PATH (required by --planner with --harness opencode)"
    fi
  fi

  # Driver journal: a planner run has no single clear name, so use a timestamp
  # id (<mode>-YYMMDD-HHMMSS) and record every plan attempt inside it.
  journal_open "planner-$(journal_new_id)" "planner run (${#PLANNER[@]} plans)" "$PLANNER_ROLE_NAME"

  started=false
  for e in "${PLANNER[@]}"; do
    module="${e%%:*}"
    rest="${e#*:}"
    plan="${rest%%:*}"
    rest="${rest#*:}"
    out="${rest%%:*}"
    rest="${rest#*:}"
    role="${rest%%:*}"
    rest="${rest#*:}"
    kmode="${rest%%:*}"
    CURRENT_MODULE="$module"

    [ "$module" = "$FROM" ] && started=true
    if [ "$started" = false ]; then
      planner_log "skipping $module (before --from $FROM)"
      continue
    fi

    if planner_should_skip "$module" "$out"; then
      planner_log "PLAN $module already DONE (see $PLANNER_RESULTS_FILE); skipping. Use --force to re-run."
      continue
    fi

    [ -n "${JOURNAL_ID:-}" ] && journal_note \
      "Planning **$module** from \`$plan\` -> \`$out\`"
    run_one_plan "$module" "$plan" "$out" "$role" "$kmode"
    rc=$?
    if [ "$rc" -ne 0 ]; then
      [ -n "${JOURNAL_ID:-}" ] && journal_fail \
        "planning $module failed after $MAX_MODEL_FAILURES consecutive failed attempts" \
        "resume with: run_sweep.sh --planner --from $module"
      log "Planner stopped at $module (exit $rc)."
      print_planner_summary
      log "Resume with: bash run_sweep.sh --planner $PLANNER_CONF --from $module"
      exit 1
    fi
    if [ -n "${JOURNAL_ID:-}" ]; then
      psteps="$(python3 -c "import json;print(len(json.load(open('$out',encoding='utf-8-sig'))['prompts']))" 2>/dev/null || echo "?")"
      journal_say "Planned **$module**: wrote \`$out\` ($psteps steps)."
    fi
  done

  write_sequential_conf_from_plans
  print_planner_summary
  planner_log "All requested design plans planned. Next: ./run_sweep.sh --sequence"
}

# ---------------------------------------------------------------------------
# sequencemd loader (--sequencemd): raw .md prompt files -> prompts JSON.
# Each conf line = one agent dispatch, top-to-bottom. Optional per-line role
# prefix: "ROLE|path.md". Lines starting with '#' and blank lines are skipped.
# md contents are dispatched VERBATIM as prompt_text; the standard handover /
# finish boilerplate is appended downstream by inner_loop like any other step.
# ---------------------------------------------------------------------------
load_sequencemd_prompts() {
  local conf="$1"
  [ -f "$conf" ] || die "sequencemd conf not found: $conf"
  mkdir -p "$(dirname "$SEQMD_PROMPTS_OUT")"
  python3 - "$conf" "$SEQMD_PROMPTS_OUT" <<'PY'
import json, os, re, sys

conf, out = sys.argv[1], sys.argv[2]
LADDER = {"mechanical", "standard", "complex", "critical"}

def resolve(p):
    # accept Git Bash style "/c/foo" alongside native and relative paths
    m = re.match(r"^/[a-zA-Z]/", p)
    if m:
        p = p[1].upper() + ":" + p[2:]
    return p

steps = []
for raw in open(conf, encoding="utf-8"):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    role, path = "", line
    if "|" in line:
        role, path = (q.strip() for q in line.split("|", 1))
    if role and role not in LADDER:
        sys.stderr.write(
            "sequencemd: role '%s' is not an implementation-ladder role "
            "(use one of: mechanical, standard, complex, critical)\n" % role)
        sys.exit(3)
    path = resolve(path)
    if not os.path.isfile(path):
        sys.stderr.write(f"sequencemd: file not found: {path}\n")
        sys.exit(3)
    title = os.path.basename(path)
    for ext in (".md", ".markdown", ".txt"):
        if title.lower().endswith(ext):
            title = title[: -len(ext)]
            break
    summary = (
        "None. This is the first authoring step of the sequence."
        if len(steps) == 0
        else "Previous steps of this sequencemd run completed their md prompts; "
             "continue the document series independently."
    )
    entry = {
        "step": len(steps) + 1,
        "title": title,
        "role": role if role else "standard",
        "previous_implementation_summary": summary,
        "prompt_text": open(path, encoding="utf-8").read(),
    }
    steps.append(entry)

if not steps:
    sys.stderr.write("sequencemd: no entries in " + conf + "\n")
    sys.exit(3)

module = "SEQMD-" + os.path.splitext(os.path.basename(conf))[0].replace(" ", "_")
with open(out, "w", encoding="utf-8") as f:
    json.dump({"module": module, "prompts": steps}, f, ensure_ascii=False, indent=1)
print(f"[sequencemd] {len(steps)} step(s) -> {out} (module {module})")
PY
}

# ---------------------------------------------------------------------------
# write_planner_conf_from_plans(): rebuild $PLANNER_CONF from the design plans
# on disk ($SEQMD_PLANS_DIR/*.md) so `--planner` can run right after
# `--sequencemd` with no hand-written conf. One line per plan:
#   MODULE_ID:path/to/design_plan.md
# where MODULE_ID is the file stem (e.g. DP-TF for DP-TF.md); the OUT/ROLE/
# KILL_MODE columns are omitted so the planner falls back to
# .run_sweep/prompts_<MODULE>.json. Ordering follows the --sequencemd conf
# top-to-bottom (the build order): a seqmd prompt named PROMPT-<X>.md (or
# <X>.md) maps to plans dir file <X>.md; any plans with no seqmd counterpart
# are appended sorted. Never fails the driver: with no plans on disk it logs
# a warning and leaves any existing conf untouched.
# ---------------------------------------------------------------------------
write_planner_conf_from_plans() {
  python3 - "$SEQMD_CONF" "$SEQMD_PLANS_DIR" "$PLANNER_CONF" <<'PY'
import glob
import os
import re
import sys

seqmd_conf, plans_dir, planner_conf = sys.argv[1:4]

def stem(p):
    base = os.path.basename(p)
    root, _ = os.path.splitext(base)
    return root

def sanitize_module(name):
    # planner conf allows [A-Za-z0-9_-]; anything else becomes "_".
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "_", name.strip().replace(" ", "_"))
    return cleaned.strip("_") or "PLAN"

# Candidate prompt-file stems in seqmd execution order.
ordered = []
if os.path.isfile(seqmd_conf):
    for raw in open(seqmd_conf, encoding="utf-8"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        path = line.split("|", 1)[1].strip() if "|" in line else line
        # Git Bash "/c/..." -> "C:/..." so basename works on Windows too.
        m = re.match(r"^/[a-zA-Z]/", path)
        if m:
            path = path[1].upper() + ":" + path[2:]
        name = stem(path)
        # PROMPT-DP-TF -> DP-TF (this repo); otherwise keep the stem as-is.
        if name.upper().startswith("PROMPT-"):
            name = name[len("PROMPT-"):]
        ordered.append(name)

plans = sorted(glob.glob(os.path.join(plans_dir, "*.md")))
if not plans:
    sys.stderr.write(
        f"sequencemd: no design plans in {plans_dir}; "
        f"leaving {planner_conf} untouched\n")
    sys.exit(0)

by_stem = {stem(p): p for p in plans}
seen = set()
entries = []
for want in ordered:
    hit = by_stem.get(want)
    if hit is None:
        # case-insensitive fallback (DP-tf vs DP-TF)
        for k, v in by_stem.items():
            if k.lower() == want.lower():
                hit = v
                break
    if hit is not None and hit not in seen:
        seen.add(hit)
        entries.append(hit)
for p in plans:
    if p not in seen:
        entries.append(p)

used_ids = set()
lines = []
for p in entries:
    mid = sanitize_module(stem(p))
    suffix = 2
    base_mid = mid
    while mid in used_ids:
        mid = f"{base_mid}_{suffix}"
        suffix += 1
    used_ids.add(mid)
    rel = os.path.relpath(p).replace(os.sep, "/")
    lines.append(f"{mid}:{rel}")

tmp = planner_conf + ".tmp"
with open(tmp, "w", encoding="utf-8", newline="\n") as f:
    f.write("# run_planner.conf - generated by run_sweep.sh --sequencemd\n")
    f.write(f"# Source plans dir: {plans_dir}\n")
    f.write(f"# Source sequence: {seqmd_conf}\n")
    f.write("# Syntax: MODULE_ID:path/to/design_plan.md[:OUT[:ROLE[:KILL_MODE]]]\n")
    f.write("# OUT omitted -> planner default .run_sweep/prompts_<MODULE>.json\n")
    f.write("#\n")
    for ln in lines:
        f.write(ln + "\n")
os.replace(tmp, planner_conf)
print(f"[sequencemd] {len(lines)} design plan(s) -> {planner_conf}")
PY
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
if [ "$HARNESS" = "opencode" ]; then
  THIS_PROJECT="$(opencode_detect_project)"
else
  THIS_PROJECT=""       # Pi mode never shells out to `opencode session list`
fi

# ---------------------------------------------------------------------------
# chat mode main (--chat / --prompt; read-only utilities run without the lock)
# ---------------------------------------------------------------------------
if [ "$LIST_CONVERSATIONS" = true ]; then
  chat_list_conversations
  exit 0
fi

if [ "$PRINT_HISTORY" = true ]; then
  chat_print_history_cmd
  exit 0
fi

if [ "$CHAT_MODE" = true ]; then
  check_legacy_locks
  acquire_lock "$LOCK_DIR" "run_sweep(chat)"
  trap 'release_lock "$LOCK_DIR"' EXIT
  run_chat_mode
  exit $?
fi

if [ "$SEQMD_MODE" = true ]; then
  load_sequencemd_prompts "$SEQMD_CONF" || exit 1
  PROMPTS_FILE="$SEQMD_PROMPTS_OUT"
  PROMPTS_GIVEN=true
  check_legacy_locks
  acquire_lock "$LOCK_DIR" "run_sweep(sequencemd)"
  trap 'release_lock "$LOCK_DIR"' EXIT
  run_module_sweep "$PROMPTS_FILE" "$GLOBAL_ROLE" "$GLOBAL_KILL_MODE"
  rc=$?
  # Always refresh run_planner.conf from whatever design plans are on disk
  # (even on failure: partial outputs are still plannable). Never masks the
  # sweep's own exit code.
  write_planner_conf_from_plans || log "!! sequencemd: could not write $PLANNER_CONF (see above); --planner will need a hand-written conf"
  exit "$rc"
fi

if [ "$PLANNER_MODE" = true ]; then
  load_planner_conf
  check_legacy_locks
  acquire_lock "$LOCK_DIR" "run_sweep(planner)"
  trap 'release_lock "$LOCK_DIR"' EXIT
  run_planner
  exit 0
fi

if [ "$SEQUENCE_MODE" = true ]; then
  load_sequence_conf
  check_legacy_locks
  acquire_lock "$LOCK_DIR" "run_sweep(sequence)"
  trap 'release_lock "$LOCK_DIR"' EXIT
  run_sequence
  exit 0
fi

check_legacy_locks
acquire_lock "$LOCK_DIR" "run_sweep(single)"
trap 'release_lock "$LOCK_DIR"' EXIT
run_module_sweep "$PROMPTS_FILE" "$GLOBAL_ROLE" "$GLOBAL_KILL_MODE"
exit $?
