# Agent operations board

## Goal

The default Overview page should show enough agents to understand the workspace
at a glance. The page is a compact operations board: one card per agent session,
grouped by who owns the next move. Session details stay off the overview and
open through an explicit action.

## State machine

The persisted session status remains the runtime fact. The board lane is a pure
projection and is never stored:

| Runtime status | Board lane | Meaning |
| --- | --- | --- |
| `waiting` | `needs_you` | The process is alive and waiting for human input. |
| `lost` | `needs_you` | The process disappeared and the session may be recovered. |
| `running` | `working` | The agent is actively processing. |
| `completed` | `finished` | Keepline received an explicit durable completion signal. |
| `idle` | `paused` | The process is alive but currently quiet. |

Runtime transitions and evidence:

- Claude Code and Codex lifecycle hooks are the primary live signal:
  `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `PostToolUse` mean
  `running`; `Stop` means the response turn ended and maps to `waiting`.
- A newer hook observation stays authoritative while its matched process is
  alive. Transcript activity and the existing process/CPU detector remain the
  fallback when no newer hook observation exists. Persist the source of the
  accepted status so this distinction survives a Keepline restart; a status
  last accepted from a scan must be recomputed from current process evidence.
- Any live state moves to `lost` when reconciliation can no longer match its
  process.
- `lost` moves back to a live state after a successful recovery and process
  reconciliation.
- Any non-completed state moves to `completed` only from an explicit hook or
  user action. `completed` is durable and process scans cannot downgrade it.
- `Stop` never means `completed`.

Runtime adapters may improve the input fact, but Herdr and Remem are optional.
After a restart, Keepline reloads persisted sessions, reconciles live processes,
and derives the board lanes again. No UI lane becomes a second source of truth.

The lane order is `needs_you`, `working`, `finished`, `paused`. Within a lane,
newer activity comes first. In `needs_you`, `waiting` sorts before `lost`.
Scores, cost, and stale warnings do not move cards between lanes.

## Layout

- Replace the score ledger with four compact Kanban lanes: Needs you, Working,
  Finished, and Paused.
- Keep cards approximately 100-112px tall and show only status, runtime, task,
  current state, project, age, and one primary action.
- Keep secondary actions in a compact overflow menu.
- Use independent vertical lane scrolling on desktop and a single stacked board
  on narrow screens without horizontal page overflow.

## Behavior

- Preserve refresh, open, recover, stop, and complete actions. Replace the
  overview's copy-ID shortcut with the complete recovery command for sessions
  that can actually be recovered.
- `Open` switches to Sessions, filters to the selected session, and expands its
  full details immediately.
- A recoverable lost session uses `Continue in terminal` as its primary action.
  Recovery opens the owning runtime in Warp, iTerm, or Terminal through the
  existing native-terminal recovery service.
- Recoverable sessions expose `Copy recovery command` in the overflow menu.
  The copied value comes from the backend recovery builder and includes the
  complete shell-safe command, not only the runtime session ID. Live sessions
  do not expose this action because running the command would duplicate them.
- The web dashboard does not create, attach, display, or own PTYs. Live agents
  remain owned by the terminal or supervisor that launched them; Keepline only
  observes their persisted hook and process state.
- Do not label a live-session action `Locate` until a runtime integration
  provides a stable terminal or pane handle. PID and TTY metadata alone are not
  sufficient to promise exact focus across terminal applications.
- Preserve the existing API fields while adding the derived board lane.
- Include completed sessions in the board response. Old lost sessions remain in
  Sessions history instead of flooding the operational board.

## Review closure contract

- Normalize Codex hook UUIDs to Keepline's canonical `codex_<uuid>` identity in
  every hook receiver before repository lookup, persistence, or events.
- Preserve a newer hook-derived `running` or `waiting` state in standalone and
  service-backed reads while the matched process is alive. Replace generated
  `Unknown task` metadata when the first real prompt arrives.
- Resolve Codex hook files from `CODEX_HOME` when set, expose that Codex hook
  trust is runtime-managed and must be verified, advertise Codex hook
  capability, and accept receiver health only when the response carries
  Keepline's lifecycle-receiver identity.
- Show Stop only when a matched PID is available. Show recovery actions only
  when the backend confirms at least one recovery method is currently valid.
- Keep the board current from the existing session event stream. Do not display
  a `Live` label for a one-shot snapshot.
- Consume Overview-to-Sessions expansion only after the requested session is
  loaded, and automatically open a collapsed group containing that session.
- Keep overflow actions inside the visible lane, display resolved project
  identity, and disclose when the 100-item board response is truncated.
- Preserve meaningful text following image attachment tags. Board lane ordering
  must not replace score ordering for the existing CLI attention queue.
- Never render an overflow trigger without at least one available action.
- Treat lifecycle-hook support and agent completion claims as separate
  capabilities. Codex completion claims remain manual-only until its receiver
  records them; Claude may advertise hook claims only when configured.
- Initialize the full runtime session identity and working directory before a
  tool event updates activity, even when `SessionStart` was missed.
- Label `lost` sessions as Recoverable only when recovery is actually
  available; otherwise label them Lost.
- Report hook installation as none, partial, or all. Any installed target with
  no healthy receiver is degraded, including a Claude-only installation.

## Verification

- Client and repository typechecks pass.
- Production build passes.
- Desktop and mobile layouts are inspected in the running web app.
