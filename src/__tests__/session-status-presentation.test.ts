import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SESSION_STATUSES,
  SESSION_STATUS_PRESENTATION,
} from '../domain/session/index.js';
import { themes } from '../ui/themes/index.js';

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort();
}

describe('session status presentation coverage', () => {
  test('presents a stopped recoverable session as interrupted instead of destroyed', () => {
    expect(SESSION_STATUS_PRESENTATION.lost.label).toBe('Interrupted');
    expect(SESSION_STATUS_PRESENTATION.lost.shortLabel).toBe('INTERRUPTED');
  });

  test('web status constants use the shared contract', () => {
    const constantsSource = readFileSync(
      join(process.cwd(), 'src/web/client/src/constants/index.ts'),
      'utf8'
    );

    expect(constantsSource).toContain('SESSION_STATUS_ORDER');
    for (const status of SESSION_STATUSES) {
      expect(constantsSource).toContain(
        `${status}: SESSION_STATUS_PRESENTATION.${status}.shortLabel`
      );
      expect(constantsSource).toContain(
        `${status}: SESSION_STATUS_PRESENTATION.${status}.icon`
      );
    }
  });

  test('ink themes define icons for every shared status', () => {
    for (const theme of Object.values(themes)) {
      expect(sortedKeys(theme.icons)).toEqual([...SESSION_STATUSES].sort());
    }
  });
});
