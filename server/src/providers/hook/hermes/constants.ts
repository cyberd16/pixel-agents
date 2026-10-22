/**
 * Hermes-specific constants. Kept separate from `server/src/constants.ts` per
 * the multi-provider convention: a single-provider build must not pull another
 * provider's facts in by accident.
 *
 * Hermes facts mirror the upstream wire contract in
 * `agent/outbound_webhooks.py` + `agent/shell_hooks.py` (Hermes Agent
 * v0.21.7): the outbound-webhook POST body is
 * `{ hook_event_name, profile, tool_name, tool_input, session_id, cwd,
 *    extra, delivery_id, timestamp }`, delivered with fixed headers
 * (`X-Hermes-Event`, `X-Hermes-Delivery`, optional
 * `X-Hermes-Signature-256`) — there is NO way to attach an
 * `Authorization` header, which is why the hook route must accept the server
 * token as a `?token=` query for this provider (see httpServer.ts).
 */

/** Hermes has no bundled hook script at all: its outbound-webhook subsystem
 *  reads targets straight from config.yaml, so there is nothing to copy to
 *  disk and the install footprint is provably just the one entry managed by
 *  hermesHookInstaller.ts. */

/** The `hooks.outbound` events we subscribe to. This list is the whole
 *  data-collection surface (same rule as CLAUDE_HOOK_EVENTS): an event we do
 *  not act on is scope we should not ask for.
 *
 *   on_session_start    → sessionStart (adopts the session as a pending
 *                         external session; carries cwd for Directory mapping)
 *   pre_tool_call       → toolStart (typing/reading animation, status line)
 *   post_tool_call      → toolEnd (character returns to idle)
 *   on_human_input_request → turnEnd{awaitingInput} — the "Waiting for input"
 *                         bubble (Hermes' analogue of Claude's
 *                         Notification(idle_prompt): a tool is blocked on the
 *                         human, e.g. MCP elicitation / vault payment)
 *   on_session_end      → turnEnd — fires PER TURN at the end of
 *                         `run_conversation()` (one turn per user message on
 *                         every surface), NOT only at session close. Carries
 *                         completed/failed/interrupted + platform in `extra`,
 *                         and since the per-turn usage snapshot also the last
 *                         response's token totals + resolved window there
 *                         (`usage`/`context_length`, integers only) — the
 *                         gauge data for this push-only provider.
 *   on_session_finalize → sessionEnd (the session is closing; retires the
 *                         character the way Claude's SessionEnd does)
 *   pre_approval_request  → permissionRequest (the "Needs approval" bubble;
 *                         Hermes' analogue of Claude's PermissionRequest hook)
 *   post_approval_response → permissionResolved (the human answered at the
 *                         CLI surface — approve/deny/timeout all clear the
 *                         bubble; Claude has no such hook and clears via its
 *                         JSONL watcher instead)
 *
 *  Approval routing fact (verified against the live envelope builder):
 *  `tools/approval_context._fire_approval_hook` promotes the bound
 *  observability-context session_id into the hook kwargs, and
 *  `agent/outbound_webhooks._serialize_payload` puts it at the envelope's
 *  top level — approval events are routable like tool events. Approval sites
 *  that fire WITHOUT a bound context post an empty session_id and are
 *  dropped by normalizeHookEvent's guard: a bubble without an owner never
 *  happens.
 *
 *  Deliberately NOT subscribed:
 *   - post_llm_call: also fires per turn, but `agent/turn_finalizer.py` passes
 *     `conversation_history=list(messages)` into the payload — subscribing
 *     would serialize the whole transcript to the endpoint on every turn,
 *     orders of magnitude more data than the office can act on. The per-turn
 *     signal we need already comes from on_session_end at near-zero cost.
 *   - agent_loop_stopped: its kwargs carry only `session_key` (no
 *     `session_id`), so it is not routable — and the office has no action
 *     for it either: the loop stop surfaces as the following turn/session
 *     events.
 *   - subagent_start / subagent_stop: Hermes sub-agents (delegate_task
 *     children) run real top-level sessions that fire their own lifecycle and
 *     tool hooks, so the office adopts each as its own character. Claude's
 *     ghost-sub-agent model (a subagent visual under the lead, no session of
 *     its own) does not fit; subscribing would double-render every child. */
export const HERMES_HOOK_EVENTS = [
  'on_session_start',
  'pre_tool_call',
  'post_tool_call',
  'pre_approval_request',
  'post_approval_response',
  'on_human_input_request',
  'on_session_end',
  'on_session_finalize',
] as const;

/** Wire identity of our subscription inside ~/.hermes/config.yaml's
 *  `hooks.outbound`: the entry name we write, recognized alongside the url
 *  suffix so a hand-edited or renamed entry is still adopted on reinstall. */
export const HERMES_OUTBOUND_ENTRY_NAME = 'pixel-agents';

/** URL path (appended to the server base) carrying our provider id and the
 *  server token as a query credential (Hermes cannot send a Bearer header).
 *  Matching is anchored at both ends the way the Claude installer anchors its
 *  hook-script path: a suffix collision must not make us claim a foreign
 *  entry, and a prefix of it must not be mistaken for ours. */
export const HERMES_HOOK_URL_PATH = '/api/hooks/hermes';

/** Suffix of the one-time pre-modification backup of config.yaml. Brand-named
 *  for the same reason as the Claude one: a foreign `.backup` must never make
 *  us believe we already saved the user's original. */
export const HERMES_CONFIG_BACKUP_SUFFIX = '.pixel-agents.backup';

/** Suffix of the temp file for the atomic tmp-write + rename. */
export const HERMES_CONFIG_TMP_SUFFIX = '.pixel-agents-tmp';

/** Mode for a config.yaml we create ourselves (token-bearing file, so the
 *  restrictive default; an existing file's mode is preserved). */
export const HERMES_CONFIG_FRESH_FILE_MODE = 0o600;

/** Attempts for the config.yaml read-modify-write cycle. Hermes itself writes
 *  this file (`hermes config set`, the setup wizard, /sethome) without
 *  coordinating with us, so — exactly like the Claude installer — we re-read
 *  immediately before committing and retry when the file changed. Narrowed,
 *  not eliminated: the same lost-update window analysis applies. */
export const HERMES_CONFIG_MUTATE_ATTEMPTS = 3;
/** Delay between mutation attempts (lets a concurrent writer finish). */
export const HERMES_CONFIG_MUTATE_RETRY_DELAY_MS = 100;

/** Per-attempt delivery timeout (seconds) written into the target entry.
 *  Hermes clamps to [1, 60]; a dead pixel-agents server must delay a delivery
 *  worker, never a tool call. The queue is fire-and-forget (256 deep, drops
 *  when full), so even a wedged office can only cost dropped events. */
export const HERMES_HOOK_TIMEOUT_SECONDS = 5;

/** Terminal name prefix used when launching Hermes in VS Code (future +Agent
 *  support; declared now so the extension's heuristic can match user-named
 *  terminals). */
export const HERMES_TERMINAL_NAME_PREFIX = 'Hermes';

/** Extra.platform values whose sessions the provider drops even when they
 *  carry a session_id: scheduled/unattended runs (cron jobs, batch scoring)
 *  share the machine's config and would otherwise flood the office with
 *  characters nobody is watching. Interactive surfaces — cli, tui, desktop,
 *  gateway platforms like telegram/discord — are all kept. */
export const HERMES_SILENT_PLATFORMS: ReadonlySet<string> = new Set(['cron', 'batch', 'subagent']);
