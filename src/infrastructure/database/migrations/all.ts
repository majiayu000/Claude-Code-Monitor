/**
 * All migrations registry
 *
 * Import all migrations and export them as an array.
 */

import type { Migration } from './index.js';
import { migration001 } from './001_initial.js';
import { migration002 } from './002_memory.js';
import { migration003 } from './003_terminal_auth.js';
import { migration004 } from './004_sessions_last_message.js';
import { migration005 } from './005_session_metadata.js';
import { migration006 } from './006_session_client.js';
import { migration007 } from './007_work_items.js';
import { migration008 } from './008_work_item_evidence.js';
import { migration009 } from './009_session_digests.js';
import { migration010 } from './010_stash_integration.js';
import { migration011 } from './011_dispatch_correlation_deadline.js';
import { migration012 } from './012_unique_dispatch_session_claim.js';

/** All available migrations */
export const allMigrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
];
