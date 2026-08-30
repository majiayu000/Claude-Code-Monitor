import { Hono } from 'hono';
import { LOCAL_API_RUNTIME_DESCRIPTORS } from '../../domain/runtime/descriptors.js';
import { localServiceState } from '../service-state.js';

const app = new Hono();

app.get('/health', (c) => c.json({
  success: true,
  data: {
    status: 'ok',
    mode: 'service',
    instanceId: localServiceState.instanceId,
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - localServiceState.startedAt.getTime()) / 1000)),
    scan: {
      running: localServiceState.scan.running,
      completed: localServiceState.scan.completed,
      lastStartedAt: localServiceState.scan.lastStartedAt?.toISOString(),
      lastCompletedAt: localServiceState.scan.lastCompletedAt?.toISOString(),
      lastError: localServiceState.scan.lastError,
    },
  },
}));

app.get('/meta', (c) => c.json({
  success: true,
  data: {
    apiVersion: '1.0',
    serviceVersion: '1.0.0',
    instanceId: localServiceState.instanceId,
    mode: 'service',
    capabilities: [
      'sessions.list',
      'sessions.complete',
      'work-items.external-upsert',
      'work-items.session-link',
      'work-items.completion-review',
      'work-items.completion-evidence.explicit-only',
      'dispatch.codex',
      'dispatch.claude-code',
    ],
    runtimes: LOCAL_API_RUNTIME_DESCRIPTORS.map((descriptor) => ({
      ...descriptor,
      capabilities: [
        ...descriptor.capabilities,
        descriptor.id === 'claude-code'
          ? 'explicit-completion-hook'
          : 'explicit-completion-manual-only',
      ],
    })),
  },
}));

export default app;
