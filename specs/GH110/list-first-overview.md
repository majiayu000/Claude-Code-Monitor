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

Runtime transitions:

- `running`, `waiting`, and `idle` may move between one another as process
  activity changes.
- Any live state moves to `lost` when reconciliation can no longer match its
  process.
- `lost` moves back to a live state after a successful recovery and process
  reconciliation.
- Any non-completed state moves to `completed` only from an explicit hook or
  user action. `completed` is durable and process scans cannot downgrade it.

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

- Preserve refresh, open, recover, stop, complete, and copy-ID actions.
- `Open` switches to Sessions, filters to the selected session, and expands its
  full details immediately.
- Preserve the existing API fields while adding the derived board lane.
- Include completed sessions in the board response. Old lost sessions remain in
  Sessions history instead of flooding the operational board.

## Verification

- Client and repository typechecks pass.
- Production build passes.
- Desktop and mobile layouts are inspected in the running web app.
