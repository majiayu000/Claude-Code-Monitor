import type { Migration } from './index.js';
import { execSql } from '../sqlite.js';

export const migration012: Migration = {
  version: 12,
  name: 'unique_dispatch_session_claim',
  up: () => {
    // Earlier builds could resolve multiple dispatches to the same Agent session.
    // Revoke every accepted evidence link for a duplicated claim before returning
    // the dispatches to explicit user resolution. The migration runner wraps all
    // three operations in one transaction, so evidence can never remain multi-owned.
    execSql(`
      UPDATE work_item_session_links
      SET acceptance_status = 'rejected',
          accepted_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE acceptance_status = 'accepted'
        AND EXISTS (
          SELECT 1
          FROM task_dispatches AS duplicate_dispatch
          WHERE duplicate_dispatch.work_item_id = work_item_session_links.work_item_id
            AND duplicate_dispatch.linked_agent_session_id = work_item_session_links.agent_session_id
            AND duplicate_dispatch.linked_agent_session_id IN (
              SELECT linked_agent_session_id
              FROM task_dispatches
              WHERE linked_agent_session_id IS NOT NULL
              GROUP BY linked_agent_session_id
              HAVING COUNT(*) > 1
            )
        )
    `);
    execSql(`
      UPDATE task_dispatches
      SET state = 'ambiguous',
          linked_agent_session_id = NULL,
          error = 'Agent session had multiple dispatch claims; resolve it explicitly.',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE linked_agent_session_id IN (
        SELECT linked_agent_session_id
        FROM task_dispatches
        WHERE linked_agent_session_id IS NOT NULL
        GROUP BY linked_agent_session_id
        HAVING COUNT(*) > 1
      )
    `);
    execSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_dispatches_unique_agent_session_claim
      ON task_dispatches(linked_agent_session_id)
      WHERE linked_agent_session_id IS NOT NULL
    `);
  },
  down: () => {
    execSql('DROP INDEX IF EXISTS idx_task_dispatches_unique_agent_session_claim');
  },
};
