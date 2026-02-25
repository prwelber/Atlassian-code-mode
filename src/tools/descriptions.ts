/**
 * Tool descriptions for the MCP server.
 *
 * These are injected into the tool definitions and shown to the model.
 * Keep them lean — every token counts.
 */

export const SPEC_TYPES = `
interface OperationInfo {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown; description?: string }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
}

interface PathItem {
  get?: OperationInfo;
  post?: OperationInfo;
  put?: OperationInfo;
  delete?: OperationInfo;
}

declare const spec: {
  jira: { paths: Record<string, PathItem> };
  confluence: { paths: Record<string, PathItem> };
};
`;

export const ATLASSIAN_TYPES = `
interface AtlassianRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

declare const atlassian: {
  jira: {
    request(opts: AtlassianRequestOptions): Promise<unknown>;
    jql(query: string, fields?: string[], maxResults?: number): Promise<{ issues: Array<{ key: string; fields: Record<string, unknown> }>; total: number }>;
    jqlV2(query: string, fields?: string[], maxResults?: number): Promise<{ issues: Array<{ key: string; fields: Record<string, unknown> }>; total: number }>;
    getIssue(key: string, fields?: string[]): Promise<unknown>;
    getTransitions(key: string): Promise<Array<{ id: string; name: string }>>;
    transition(key: string, transitionId: string, fields?: unknown): Promise<void>;
    addComment(key: string, body: string): Promise<unknown>;
    createIssue(project: string, type: string, fields: Record<string, unknown>): Promise<{ key: string }>;
    updateIssue(key: string, fields: Record<string, unknown>): Promise<void>;
    linkIssues(inwardKey: string, outwardKey: string, linkType: string): Promise<void>;
  };
  confluence: {
    request(opts: AtlassianRequestOptions): Promise<unknown>;
    cql(query: string, maxResults?: number): Promise<{ results: Array<{ id: string; title: string; type: string }> }>;
    getPageText(pageId: string): Promise<{ title: string; body: string }>;
    getPageById(pageId: string): Promise<unknown>;
    createPage(spaceKey: string, title: string, body: string): Promise<{ id: string; title: string }>;
    updatePage(pageId: string, title: string, body: string): Promise<void>;
    getSpaces(): Promise<Array<{ key: string; name: string }>>;
    searchInSpace(spaceKey: string, query: string): Promise<{ results: Array<{ id: string; title: string; type: string }> }>;
  };
};
`;

export function buildSearchDescription(
  jiraEndpointCount: number,
  confluenceEndpointCount: number
): string {
  return `Search the Atlassian OpenAPI spec to discover available endpoints, parameters, and schemas. All $refs are pre-resolved inline.

Jira: ${jiraEndpointCount} endpoints | Confluence: ${confluenceEndpointCount} endpoints

Types:
${SPEC_TYPES}

Write an async arrow function in JavaScript that returns the result.
Do NOT use TypeScript syntax.

Examples:

// Find endpoints by path keyword
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.jira.paths)) {
    if (path.includes('transition')) {
      for (const [method, op] of Object.entries(methods)) {
        if (typeof op === 'object' && op.summary) {
          results.push({ method: method.toUpperCase(), path, summary: op.summary });
        }
      }
    }
  }
  return results;
}

// Get request body schema for an endpoint
async () => {
  const op = spec.jira.paths['/rest/api/3/issue']?.post;
  return { summary: op?.summary, requestBody: op?.requestBody };
}

// Search by tag
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.jira.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (typeof op === 'object' && op.tags?.some(t => t.toLowerCase().includes('search'))) {
        results.push({ method: method.toUpperCase(), path, summary: op.summary });
      }
    }
  }
  return results;
}`;
}

export function buildExecuteDescription(): string {
  return `Execute JavaScript against the Atlassian APIs. Write code using the typed atlassian SDK. Can chain multiple API calls, filter results, and return only what's needed.

Available in your code:
${ATLASSIAN_TYPES}

Response-size helpers (use these to avoid truncation):
- select(items, ['key', 'fields.summary', 'fields.status.name']) — pick dot-paths from each item
- limitFields(items, ['key', 'summary']) — pick top-level keys from each item
- estimateSize(value) — returns { tokens, chars } estimate before returning

jql() vs jqlV2():
- jql() tries /rest/api/3/search first, auto-falls back to /search/jql on HTTP 410
- jqlV2() uses /rest/api/3/search/jql directly (cursor-based pagination via nextPageToken)

Your code must be an async arrow function that returns the result.
Do NOT use TypeScript syntax — no type annotations, interfaces, or generics.
Do NOT define named functions then call them — just write the arrow function body directly.

Example:
async () => {
  const bugs = await atlassian.jira.jql(
    'project = CARE AND type = Bug AND status != Done',
    ['summary', 'status', 'assignee'],
    10
  );
  return select(bugs.issues, ['key', 'fields.summary', 'fields.status.name']);
}`;
}
