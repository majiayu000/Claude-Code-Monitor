/**
 * Request host/origin allowlist helpers for browser-facing local services.
 */

import {
  getConfiguredAllowedOrigins,
  getLocalInterfaceHosts,
  isLoopbackHost,
  isWildcardBindHost,
} from './web-network.js';

export function getAllowedRequestHosts(
  hostname: string,
  port: number,
  configuredOrigins: string[] = getConfiguredAllowedOrigins(),
  localHosts: string[] = getLocalInterfaceHosts(),
): Set<string> {
  const allowed = new Set<string>();
  addHost(allowed, hostname, port);

  if (isLoopbackHost(hostname) || isWildcardBindHost(hostname)) {
    addHost(allowed, '127.0.0.1', port);
    addHost(allowed, 'localhost', port);
    addHost(allowed, '[::1]', port);
  }

  if (isWildcardBindHost(hostname)) {
    for (const localHost of localHosts) {
      addHost(allowed, localHost, port);
    }
  }

  for (const origin of configuredOrigins) {
    addConfiguredOriginHost(allowed, origin);
  }

  return allowed;
}

export function isAllowedRequestHost(
  req: Request,
  hostname: string,
  port: number,
  configuredOrigins?: string[],
  localHosts?: string[],
): boolean {
  const normalizedHost = normalizeHostHeader(req.headers.get('host'));
  if (!normalizedHost) return false;
  return getAllowedRequestHosts(hostname, port, configuredOrigins, localHosts).has(normalizedHost);
}

export function isLoopbackHostHeader(hostHeader: string | null | undefined): boolean {
  const host = normalizeHostHeader(hostHeader);
  if (!host) return false;
  return isLoopbackHost(stripPort(host));
}

export function isLoopbackOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function isAllowedFetchMetadata(req: Request): boolean {
  const fetchSite = req.headers.get('sec-fetch-site');
  if (!fetchSite) return true;
  return ['same-origin', 'same-site', 'none'].includes(fetchSite.trim().toLowerCase());
}

function addHost(allowed: Set<string>, hostname: string, port: number) {
  const host = normalizeHostHeader(formatHost(hostname));
  if (!host) return;
  allowed.add(host);
  allowed.add(normalizeHostHeader(`${host}:${port}`) ?? `${host}:${port}`);
}

function addConfiguredOriginHost(allowed: Set<string>, origin: string) {
  try {
    allowed.add(new URL(origin).host.toLowerCase());
  } catch {
    // Ignore malformed opt-in origins rather than widening the allowlist.
  }
}

function normalizeHostHeader(hostHeader: string | null | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader.trim()}`).host.toLowerCase();
  } catch {
    return null;
  }
}

function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(0, end + 1) : host;
  }
  return host.split(':')[0] ?? host;
}

function formatHost(hostname: string): string {
  return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
}
