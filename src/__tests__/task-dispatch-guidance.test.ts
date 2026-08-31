import { expect, test } from 'bun:test';
import { DISPATCH_CORRELATION_TIMEOUT_ERROR } from '../services/task-dispatch.service.js';

test('dispatch timeout points users to terminal trust and login prompts', () => {
  expect(DISPATCH_CORRELATION_TIMEOUT_ERROR).toContain('terminal');
  expect(DISPATCH_CORRELATION_TIMEOUT_ERROR).toContain('trust or login');
});
