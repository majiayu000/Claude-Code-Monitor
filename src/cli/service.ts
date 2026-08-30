import { startKeeplineService } from '../services/service-runtime.js';

interface ServiceOptions {
  port?: string;
  scanInterval?: string;
}

interface ServiceRuntimeOptions {
  scanCommand?: string[];
}

export async function serviceCommand(
  options: ServiceOptions,
  runtimeOptions: ServiceRuntimeOptions = {}
): Promise<void> {
  const port = options.port ? Number.parseInt(options.port, 10) : 3377;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid port number');
  }
  const scanIntervalSeconds = options.scanInterval === undefined
    ? 60
    : Number.parseFloat(options.scanInterval);
  if (!Number.isFinite(scanIntervalSeconds) || scanIntervalSeconds < 0) {
    throw new Error('Invalid scan interval');
  }
  const service = await startKeeplineService({
    port,
    scanIntervalMs: scanIntervalSeconds * 1000,
    scanCommand: runtimeOptions.scanCommand,
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await service.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise<void>(() => {});
}
