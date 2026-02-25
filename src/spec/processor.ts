/**
 * OpenAPI spec processor.
 *
 * Downloads Atlassian OpenAPI specs, resolves $refs inline,
 * strips non-essential metadata, and outputs a lean JSON
 * suitable for embedding in the MCP server.
 *
 * Following Cloudflare's pattern: resolve $refs with circular
 * reference detection, extract only essential fields per operation.
 */

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;

interface OperationObject {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown;
  requestBody?: unknown;
  responses?: unknown;
  deprecated?: boolean;
  'x-atlassian-experimental'?: unknown;
}

/**
 * Resolve all $ref references inline.
 * Detects circular references and replaces with { $circular: ref }.
 */
export function resolveRefs(
  obj: unknown,
  root: Record<string, unknown>,
  seen = new Set<string>()
): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((item) => resolveRefs(item, root, new Set(seen)));

  const record = obj as Record<string, unknown>;

  if ('$ref' in record && typeof record.$ref === 'string') {
    const ref = record.$ref;
    if (seen.has(ref)) return { $circular: ref };
    seen.add(ref);

    const parts = ref.replace('#/', '').split('/');
    let resolved: unknown = root;
    for (const part of parts) {
      const decodedPart = part.replace(/~1/g, '/').replace(/~0/g, '~');
      resolved = (resolved as Record<string, unknown>)?.[decodedPart];
    }
    if (resolved === undefined) return { $unresolved: ref };
    return resolveRefs(resolved, root, seen);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = resolveRefs(value, root, new Set(seen));
  }
  return result;
}

/**
 * Process a raw OpenAPI spec into the simplified format used by the search tool.
 * Resolves all $refs and extracts only fields needed for discovery.
 */
export function processSpec(spec: Record<string, unknown>): {
  paths: Record<string, Record<string, unknown>>;
  endpointCount: number;
} {
  const rawPaths = (spec.paths || {}) as Record<
    string,
    Record<string, OperationObject>
  >;
  const paths: Record<string, Record<string, unknown>> = {};
  let endpointCount = 0;

  for (const [path, pathItem] of Object.entries(rawPaths)) {
    if (!pathItem) continue;
    paths[path] = {};

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      // Skip deprecated and experimental endpoints
      if (op.deprecated) continue;
      if (op['x-atlassian-experimental']) continue;

      endpointCount++;
      paths[path][method] = {
        summary: op.summary,
        description: op.description,
        tags: op.tags,
        parameters: resolveRefs(op.parameters, spec),
        requestBody: resolveRefs(op.requestBody, spec),
        responses: resolveRefs(op.responses, spec),
      };
    }

    // Remove empty path entries
    if (Object.keys(paths[path]).length === 0) {
      delete paths[path];
    }
  }

  return { paths, endpointCount };
}

/**
 * Strip x-atlassian-* and other non-essential metadata from a processed spec.
 */
export function stripMetadata(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripMetadata);

  const record = obj as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    // Skip Atlassian-specific extension fields
    if (key.startsWith('x-atlassian')) continue;
    if (key.startsWith('x-experimental')) continue;
    // Skip verbose fields that aren't useful for discovery
    if (key === 'externalDocs') continue;
    if (key === 'x-adf-schema') continue;

    result[key] = stripMetadata(value);
  }

  return result;
}
