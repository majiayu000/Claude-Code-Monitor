export type WebSessionSource = 'standalone' | 'service';

let currentSource: WebSessionSource = 'standalone';

export function setWebSessionSource(source: WebSessionSource): void {
  currentSource = source;
}

export function getWebSessionSource(): WebSessionSource {
  return currentSource;
}
