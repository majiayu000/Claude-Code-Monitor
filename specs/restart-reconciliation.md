# Restart reconciliation

## Goal

Keepline must remain useful when Herdr, the dashboard, or Keepline itself exits.
After Keepline starts again it must rebuild live agent state from local native
session files and the current process table without presenting persisted live
state as current.

## Ownership and decoupling

- Keepline owns local process discovery, runtime state reconciliation, durable
  session projections, and recovery actions.
- Claude Code and Codex native session files are Keepline's standalone source
  for conversation identity and recovery.
- Herdr is an optional terminal host and is not a data dependency.
- Remem may later enrich session metadata through an adapter, but Keepline's
  startup, scanning, persistence, status display, and recovery must work when
  Remem is absent or unavailable.

## Behavior

1. Acquire the Service Mode HTTP and lifecycle listeners before changing shared
   session state. Until startup reconciliation completes, health, metadata, and
   local authentication remain available while operational routes return 503.
2. Convert every persisted `running`/`waiting`/`idle` row to `lost` and clear
   its PID and TTY.
3. Run one complete isolated startup scan, including old transcripts and
   subagents, then promote every live process match back to a live state.
4. Keep later periodic scans bounded for normal steady-state operation.
5. Preserve explicit `completed` rows.
6. Keep the stored domain value `lost` for API compatibility, but present it as
   **Interrupted**: the live process is gone while the durable session record
   remains available for recovery checks.

## Verification

- A repository test proves invalidation clears only stale live state.
- Service Mode tests prove listener failures preserve live claims, operational
  routes stay unavailable during reconciliation, and later scans remain bounded.
- Presentation tests prove the shared label is `Interrupted`.
- Typecheck, focused tests, and the production build pass.
