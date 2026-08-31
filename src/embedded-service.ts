#!/usr/bin/env bun

import { serviceCommand } from './cli/service.js';
import { serviceScanCommand } from './cli/service-scan.js';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';

function commandArguments(): string[] {
  const args = process.argv.slice(1);
  while (
    args[0] === process.execPath ||
    args[0]?.endsWith('/keepline-service') ||
    args[0]?.endsWith('\\keepline-service.exe') ||
    args[0]?.endsWith('/embedded-service.ts') ||
    args[0]?.endsWith('\\embedded-service.ts')
  ) {
    args.shift();
  }
  return args;
}

function parseServiceOptions(args: string[]): {
  port?: string;
  scanInterval?: string;
  exitOnStdinClose?: boolean;
} {
  const options: {
    port?: string;
    scanInterval?: string;
    exitOnStdinClose?: boolean;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === 'service') continue;
    if (argument === '--port' || argument === '-p') {
      options.port = args[++index];
      if (!options.port) throw new Error(`${argument} requires a value`);
      continue;
    }
    if (argument === '--scan-interval') {
      options.scanInterval = args[++index];
      if (!options.scanInterval) throw new Error(`${argument} requires a value`);
      continue;
    }
    if (argument === '--exit-on-stdin-close') {
      options.exitOnStdinClose = true;
      continue;
    }
    throw new Error(`Unknown embedded service argument: ${argument}`);
  }
  return options;
}

const cfg = config.get();
logger.configure({
  level: cfg.logLevel,
  file: cfg.fileLogging,
  console: true,
});

const args = commandArguments();
if (args[0] === '_service-scan') {
  if (args.length !== 1) throw new Error('_service-scan does not accept arguments');
  await serviceScanCommand();
} else {
  await serviceCommand(parseServiceOptions(args), {
    scanCommand: [process.execPath, '_service-scan'],
  });
}
