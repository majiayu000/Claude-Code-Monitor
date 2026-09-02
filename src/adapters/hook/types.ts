/**
 * Hook module types
 */

/** Lifecycle hook event types from Claude Code and Codex that Keepline consumes. */
export type HookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'SessionStart'
  | 'Stop'
  | 'UserPromptSubmit';

/**
 * Internal, normalized hook event payload.
 *
 * Claude Code delivers hook data as JSON on stdin (fields such as
 * `hook_event_name`, `tool_response`) and does not set `$CLAUDE_*` env vars.
 * The server parses that native payload into these normalized shapes.
 */
export interface HookEventPayload {
  event_type: HookEventType;
  session_id: string;
  cwd: string;
  timestamp: string;
  transcript_path?: string;
}

/** Tool use hook event */
export interface ToolUseHookEvent extends HookEventPayload {
  event_type: 'PreToolUse' | 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output?: string;
}

/** Notification hook event */
export interface NotificationHookEvent extends HookEventPayload {
  event_type: 'Notification';
  message: string;
}

/** Session start hook event */
export interface SessionStartHookEvent extends HookEventPayload {
  event_type: 'SessionStart';
  source?: string;
}

/** Stop hook event */
export interface StopHookEvent extends HookEventPayload {
  event_type: 'Stop';
  reason?: string;
}

/** User prompt submit event */
export interface UserPromptSubmitHookEvent extends HookEventPayload {
  event_type: 'UserPromptSubmit';
  prompt: string;
}

/** Union type for all hook events */
export type HookEvent =
  | ToolUseHookEvent
  | NotificationHookEvent
  | SessionStartHookEvent
  | StopHookEvent
  | UserPromptSubmitHookEvent;

/** A single command entry inside a Claude settings hook matcher block. */
export interface ClaudeHookCommandHandler {
  type?: 'command' | string;
  command: string;
  args?: string[];
  timeout?: number;
  [key: string]: unknown;
}

export type HookCommandEntry = ClaudeHookCommandHandler;

/** Claude Code matcher block shape: hooks.<Event>[{ matcher?, hooks: [...] }] */
export interface ClaudeHookMatcherGroup {
  matcher?: string;
  hooks: ClaudeHookCommandHandler[];
  [key: string]: unknown;
}

export type ClaudeHookMatcher = ClaudeHookMatcherGroup;
export type ClaudeHookConfig = ClaudeHookCommandHandler | ClaudeHookMatcherGroup;

/** Shared JSON hook settings shape used by Claude Code and Codex. */
export interface ClaudeSettings {
  hooks?: Partial<Record<HookEventType, ClaudeHookConfig[]>>;
  [key: string]: unknown;
}
