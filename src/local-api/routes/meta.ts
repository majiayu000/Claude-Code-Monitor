import { Hono } from 'hono';
import { LOCAL_API_RUNTIME_DESCRIPTORS } from '../../domain/runtime/descriptors.js';
import { localServiceState } from '../service-state.js';
import { isLifecycleHookInstalled } from '../../adapters/hook/installer.js';

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
    lifecycleHook: {
      receiverRunning: localServiceState.lifecycleHook.receiverRunning,
      installedForCurrentReceiver:
        localServiceState.lifecycleHook.receiverRunning &&
        localServiceState.lifecycleHook.port !== undefined &&
        isLifecycleHookInstalled(localServiceState.lifecycleHook.port),
    },
  },
}));

app.get('/meta', (c) => {
  const hookConfigured = (runtimeId: string) =>
    localServiceState.lifecycleHook.receiverRunning &&
      localServiceState.lifecycleHook.port !== undefined &&
      isLifecycleHookInstalled(localServiceState.lifecycleHook.port, runtimeId);
  return c.json({ success: true, data: {
    apiVersion: '1.0',
    serviceVersion: '1.0.0',
    instanceId: localServiceState.instanceId,
    mode: 'service',
    capabilities: [
      'sessions.list',
      'sessions.complete',
      'sessions.recovery.preview',
      'sessions.recovery.execute',
      'work-items.external-upsert',
      'work-items.session-link',
      'work-items.completion-review',
      'work-items.completion-evidence.explicit-only',
      'dispatch.codex',
      'dispatch.claude-code',
    ],
    runtimes: LOCAL_API_RUNTIME_DESCRIPTORS.map((descriptor) => {
      const lifecycleHookConfigured = hookConfigured(descriptor.id);
      return {
        ...descriptor,
        capabilities: [
          ...descriptor.capabilities,
          'explicit-completion-manual-only',
          lifecycleHookConfigured
            ? 'session-lifecycle-hook'
            : 'session-lifecycle-hook-unconfigured',
          descriptor.id === 'claude-code'
            ? lifecycleHookConfigured
              ? 'agent-completion-claim-hook'
              : 'agent-completion-claim-hook-unconfigured'
            : 'agent-completion-claim-manual-only',
          ...(descriptor.id === 'codex' && lifecycleHookConfigured
            ? ['hook-trust-runtime-managed']
            : []),
        ],
      };
    }),
  }});
});

export default app;
