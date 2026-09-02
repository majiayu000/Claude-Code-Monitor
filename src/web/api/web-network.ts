/** Shared local-host and configured-origin helpers for the web dashboard. */

import { hostname as osHostname, networkInterfaces } from 'os';

export function getConfiguredAllowedOrigins(): string[] {
  const values = [
    process.env.KEEPLINE_PUBLIC_ORIGIN,
    process.env.KEEPLINE_ALLOWED_ORIGINS,
  ];
  return values
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export function isWildcardBindHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

export function getLocalInterfaceHosts(): string[] {
  const hosts = new Set<string>();
  const machineHostname = osHostname().trim();
  if (machineHostname) {
    hosts.add(machineHostname);
  }

  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.internal || !address.address || address.address.includes('%')) continue;
      hosts.add(address.address);
    }
  }

  return [...hosts];
}
