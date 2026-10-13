export const MAX_TEXT_FIELD_LENGTH = 2000;

export function truncateLargeFields(obj: unknown, maxLength = MAX_TEXT_FIELD_LENGTH): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    if (obj.length > maxLength) {
      return obj.slice(0, maxLength) + `... [truncated, ${obj.length - maxLength} chars omitted]`;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => truncateLargeFields(item, maxLength));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === '_fullEvent' || key === '_rawResponse') {
        continue;
      }
      result[key] = truncateLargeFields(value, maxLength);
    }
    return result;
  }

  return obj;
}
