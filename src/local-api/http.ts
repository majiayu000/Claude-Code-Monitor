import type { Context } from 'hono';

export async function readJsonObject(c: Context): Promise<{
  data?: Record<string, unknown>;
  response?: Response;
}> {
  try {
    const value = await c.req.json<unknown>();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { response: c.json({ success: false, error: 'Request body must be an object' }, 400) };
    }
    return { data: value as Record<string, unknown> };
  } catch {
    return { response: c.json({ success: false, error: 'Invalid JSON body' }, 400) };
  }
}

export function readRequiredString(
  c: Context,
  data: Record<string, unknown>,
  key: string,
  maxLength: number
): { value?: string; response?: Response } {
  const raw = data[key];
  if (typeof raw !== 'string' || !raw.trim()) {
    return { response: c.json({ success: false, error: `${key} is required` }, 400) };
  }
  const value = raw.trim();
  if (value.length > maxLength) {
    return {
      response: c.json({ success: false, error: `${key} must be ${maxLength} characters or fewer` }, 400),
    };
  }
  return { value };
}

export function readOptionalString(
  c: Context,
  data: Record<string, unknown>,
  key: string,
  maxLength: number
): { value?: string; response?: Response } {
  const raw = data[key];
  if (raw == null) return {};
  if (typeof raw !== 'string') {
    return { response: c.json({ success: false, error: `${key} must be a string` }, 400) };
  }
  const value = raw.trim();
  if (value.length > maxLength) {
    return {
      response: c.json({ success: false, error: `${key} must be ${maxLength} characters or fewer` }, 400),
    };
  }
  return { value: value || undefined };
}
