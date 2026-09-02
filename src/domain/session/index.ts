/**
 * Session domain exports
 */

// Entity and types
export type {
  Session,
  SessionListItem,
  ParsedSessionData,
  AggregatedSession,
  AggregatedSessionListItem,
  CreateSessionInput,
  UpdateSessionInput,
  SessionStats,
} from './entity.js';

export {
  extractTaskPrompt,
  generateTitle,
  isGeneratedSessionTitle,
} from './entity.js';

// Value objects
export type {
  AgentClient,
  SessionStatus,
  SessionStatusSource,
  ToolCallInfo,
  ProcessInfo,
  ClaudeSessionFile,
} from './value-objects.js';

export {
  AGENT_CLIENTS,
  SESSION_STATUSES,
  isActiveStatus,
  needsAttention,
} from './value-objects.js';

export type { SessionStatusPresentation } from './status-presentation.js';

export {
  SESSION_STATUS_ORDER,
  SESSION_STATUS_PRESENTATION,
  getSessionStatusPresentation,
} from './status-presentation.js';

// Events
export type {
  SessionEvent,
  SessionDiscovered,
  SessionUpdated,
  SessionLost,
  SessionRecovered,
  SessionCompleted,
  ToolUsageEvent,
  ScanComplete,
  SessionDomainEvent,
} from './events.js';

export {
  createSessionDiscoveredEvent,
  createSessionUpdatedEvent,
  createSessionLostEvent,
  createSessionRecoveredEvent,
  createSessionCompletedEvent,
  createScanCompleteEvent,
} from './events.js';

// Repository interface
export type {
  ActiveSessionRecord,
  ExistingSessionSummary,
  ISessionRepository,
  SessionUpsertData,
} from './repository.js';
