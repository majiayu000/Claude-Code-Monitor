import {
  getAggregatedSessions,
  getAggregatedSessionsBasic,
  getPersistedSessions,
  getPersistedSessionsBasic,
} from '../../services/session.aggregator.js';
import type {
  AggregatedSession,
  BasicAggregatedSession,
} from '../../services/session.types.js';

export type WebSessionSource = 'standalone' | 'service';

let currentSource: WebSessionSource = 'standalone';

export function setWebSessionSource(source: WebSessionSource): void {
  currentSource = source;
}

export function getWebSessionSource(): WebSessionSource {
  return currentSource;
}

export function selectWebSessionSnapshot<T>(
  source: WebSessionSource,
  standalone: () => T,
  service: () => T
): T {
  return source === 'service' ? service() : standalone();
}

/** Read the correct snapshot without letting Service-backed routes rescan processes. */
export function getWebSessions(): AggregatedSession[] {
  return selectWebSessionSnapshot(
    currentSource,
    getAggregatedSessions,
    getPersistedSessions
  );
}

export function getWebSessionsBasic(): BasicAggregatedSession[] {
  return selectWebSessionSnapshot(
    currentSource,
    getAggregatedSessionsBasic,
    getPersistedSessionsBasic
  );
}
