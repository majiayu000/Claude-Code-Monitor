// This route module is shared with the web app, but its dependency graph is deliberately
// SQLite-only: no transcript scan, recovery, pricing, memory, PTY or terminal websocket.
export { default } from '../../web/api/routes/work-item-evidence.js';
