import { Hono } from 'hono';
import {
  aggregateProjectSummaries,
  getProjectOverviewStats,
} from '../../../services/project.aggregator.js';
import { logger } from '../../../lib/logger.js';
import { authMiddleware } from '../middleware/auth.js';
import { serializeProjectSummaries } from '../project-response.js';
import { getRuntimeScanStatus } from '../../../services/runtime-status.js';
import { getWebSessions } from '../session-source.js';

const app = new Hono();
app.use('*', authMiddleware);

app.get('/', async (c) => {
  try {
    const fields = c.req.query('fields') || 'basic';
    const sessions = getWebSessions();
    const projects = aggregateProjectSummaries(sessions);

    return c.json({
      success: true,
      data: {
        projects: serializeProjectSummaries(projects, {
          includeSessions: fields === 'full',
          sessionFields: fields === 'full' ? 'full' : 'basic',
        }),
        stats: getProjectOverviewStats(projects),
        runtimeScan: getRuntimeScanStatus(),
      },
    });
  } catch (error) {
    logger.error('Failed to get projects', error);
    return c.json({ success: false, error: 'Failed to get projects' }, 500);
  }
});

export default app;
