import { randomUUID } from 'crypto';

export const localServiceState = {
  instanceId: randomUUID(),
  startedAt: new Date(),
  scan: {
    running: false,
    completed: false,
    lastStartedAt: undefined as Date | undefined,
    lastCompletedAt: undefined as Date | undefined,
    lastError: undefined as string | undefined,
  },
  lifecycleHook: {
    receiverRunning: false,
    port: undefined as number | undefined,
  },
};
