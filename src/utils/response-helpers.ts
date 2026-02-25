/**
 * Response-size guardrails for sandbox code.
 *
 * These helpers are injected into the sandbox context so agents can
 * shape API responses before they hit the truncation limit.
 */

/**
 * Pick only specified keys from each object in an array.
 *
 * Usage in sandbox:
 *   const issues = await atlassian.jira.jql('project = PROJ', ['summary', 'status']);
 *   return select(issues.issues, ['key', 'fields.summary', 'fields.status.name']);
 */
export function select<T extends Record<string, unknown>>(
  items: T[],
  paths: string[]
): Record<string, unknown>[] {
  return items.map((item) => {
    const result: Record<string, unknown> = {};
    for (const path of paths) {
      const keys = path.split('.');
      let value: unknown = item;
      for (const key of keys) {
        if (value && typeof value === 'object' && key in (value as Record<string, unknown>)) {
          value = (value as Record<string, unknown>)[key];
        } else {
          value = undefined;
          break;
        }
      }
      result[path] = value;
    }
    return result;
  });
}

/**
 * Pick only specified top-level keys from each object in an array.
 *
 * Usage in sandbox:
 *   return limitFields(issues, ['key', 'summary']);
 */
export function limitFields<T extends Record<string, unknown>>(
  items: T[],
  keys: string[]
): Record<string, unknown>[] {
  return items.map((item) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key in item) {
        result[key] = item[key];
      }
    }
    return result;
  });
}

/**
 * Estimate the token cost of a value before returning it.
 * Returns { tokens, value } so agents can check size.
 *
 * Usage in sandbox:
 *   const result = await atlassian.jira.jql(...);
 *   const sized = estimateSize(result);
 *   if (sized.tokens > 3000) return select(result.issues, ['key', 'fields.summary']);
 *   return result;
 */
export function estimateSize(value: unknown): { tokens: number; chars: number } {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    chars: text.length,
    tokens: Math.ceil(text.length / 4),
  };
}

/**
 * Source code for helpers injected into sandbox bootstrap.
 * These are serialized as strings and eval'd inside the isolate / VM.
 */
export const SANDBOX_HELPERS_SOURCE = `
function select(items, paths) {
  if (!Array.isArray(items)) return items;
  return items.map(function(item) {
    var result = {};
    for (var i = 0; i < paths.length; i++) {
      var keys = paths[i].split('.');
      var value = item;
      for (var j = 0; j < keys.length; j++) {
        if (value && typeof value === 'object' && keys[j] in value) {
          value = value[keys[j]];
        } else {
          value = undefined;
          break;
        }
      }
      result[paths[i]] = value;
    }
    return result;
  });
}

function limitFields(items, keys) {
  if (!Array.isArray(items)) return items;
  return items.map(function(item) {
    var result = {};
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] in item) {
        result[keys[i]] = item[keys[i]];
      }
    }
    return result;
  });
}

function estimateSize(value) {
  var text = typeof value === 'string' ? value : JSON.stringify(value);
  return { chars: text.length, tokens: Math.ceil(text.length / 4) };
}
`;
