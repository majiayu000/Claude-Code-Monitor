import { Hono } from 'hono';
import { rateLimit } from '../web/api/middleware/rateLimit.js';
import auth from './routes/auth.js';
import meta from './routes/meta.js';
import dispatch from './routes/dispatch.js';
import workItemEvidence from './routes/evidence.js';
import v1Sessions from './routes/sessions.js';
import workItems from './routes/work-items.js';

export function createLocalApiApp(): Hono {
  const app = new Hono();
  app.use('/api/v1/*', rateLimit(500, 60 * 1000));
  app.route('/api/v1', meta);
  app.route('/api/v1/auth', auth);
  app.route('/api/v1/sessions', v1Sessions);
  app.route('/api/v1/work-items', workItemEvidence);
  app.route('/api/v1/work-items', workItems);
  app.route('/api/v1', dispatch);
  return app;
}
