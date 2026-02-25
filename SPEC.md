# Atlassian Code Mode MCP Server — Implementation Spec

**Author:** GSD Bot (for Phil Welber)
**Date:** Feb 25, 2026
**Status:** Draft Spec (Revised after Cloudflare Code Mode source review)

---

## Problem Statement

The current Atlassian MCP integration floods Claude Code's context
window from both directions:

**Input side (tool definitions):**
- The `sooperset/mcp-atlassian` server registers 20+ individual tools
  (jira_search, jira_get_issue, jira_create_issue, jira_update_issue,
  jira_transition_issue, confluence_search, confluence_get_page,
  confluence_create_page, etc.)
- The official `atlassian/atlassian-mcp-server` (Rovo) has a similar
  surface area covering Jira, Confluence, and Compass
- Each tool definition includes name, description, and full JSON
  Schema for inputs — estimated 15-25K tokens for the full set
- These definitions are injected on every turn, even when the user
  isn't asking about Jira

**Output side (tool results):**
- A single Jira issue response includes: summary, description (ADF
  format — deeply nested JSON), comments (full thread), changelog,
  attachments metadata, custom fields, subtasks, links, worklog — easily
  10-50KB per issue
- A JQL search returning 20 issues: 100-500KB of raw JSON
- A Confluence page: full ADF body content, metadata, ancestors,
  labels — 20-100KB per page
- After 3-4 Atlassian queries, 40%+ of context is consumed by raw API output

**Impact:**
- Claude Code sessions become sluggish after ~30 minutes of Atlassian-heavy work
- Auto-compaction loses earlier context (instructions, code changes, decisions)
- Model quality degrades as relevant context gets crowded out
- Engineers waste tokens (and money) on data the model never needs

---

## Proposed Solution

Build an **Atlassian Code Mode MCP Server** that replaces 20+ tools
with 2 primary tools: `search` and `execute`, plus a lightweight `stats`
diagnostic tool (3 total). The model writes JavaScript against a
typed SDK to query Jira and Confluence, and only the results it needs
enter the context window.

### Architecture

```
┌──────────────┐         ┌──────────────────────────────────────────┐
│  Claude Code │         │  Atlassian Code Mode MCP Server          │
│              │  MCP    │                                          │
│  3 tools:    │◄───────►│  ┌─────────────────────────────────────┐ │
│  - search    │         │  │  Sandbox (isolated-vm)              │ │
│  - execute   │         │  │                                     │ │
│  - stats     │         │  │  LLM-generated JS runs here         │ │
│              │         │  │  atlassian.jira.*() → API calls     │ │
│              │         │  │  atlassian.confluence.*() → API     │ │
│              │         │  │                                     │ │
│              │         │  │  Only stdout/return enters context  │ │
│              │         │  └─────────────────────────────────────┘ │
│              │         │                                          │
│              │         │  ┌─────────────────────────────────────┐ │
│              │         │  │  OpenAPI Spec (embedded JSON)       │ │
│              │         │  │  Jira: ~400 endpoints (resolved)    │ │
│              │         │  │  Confluence: ~150 endpoints          │ │
│              │         │  │  $refs pre-resolved, stripped       │ │
│              │         │  └─────────────────────────────────────┘ │
└──────────────┘         └──────────────────────────────────────────┘
```

### Tool Surface Area

The MCP server exposes exactly **3 tools** (~1,200 tokens total):

```json
[
  {
    "name": "search",
    "description": "Search the Atlassian (Jira + Confluence) OpenAPI spec to discover available endpoints, their parameters, and response schemas. Write JavaScript to query the spec object. All $refs are pre-resolved inline.\n\nTypes:\n...(SPEC_TYPES)...\n\nExamples:\n// Find endpoints by path keyword\nasync () => {\n  const results = [];\n  for (const [path, methods] of Object.entries(spec.jira.paths)) {\n    if (path.includes('transition')) {\n      for (const [method, op] of Object.entries(methods)) {\n        if (typeof op === 'object' && op.summary) {\n          results.push({ method: method.toUpperCase(), path, summary: op.summary });\n        }\n      }\n    }\n  }\n  return results;\n}\n\n// Get request body schema for creating an issue\nasync () => {\n  const op = spec.jira.paths['/rest/api/3/issue']?.post;\n  return { summary: op?.summary, requestBody: op?.requestBody };\n}",
    "inputSchema": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "description": "JavaScript async arrow function to search the OpenAPI spec"
        }
      },
      "required": ["code"]
    }
  },
  {
    "name": "execute",
    "description": "Execute JavaScript against the Atlassian APIs. Write code using the typed `atlassian` SDK. Can chain multiple API calls, filter results, and return only what's needed.\n\nAvailable in your code:\n...(ATLASSIAN_TYPES)...\n\nYour code must be an async arrow function that returns the result.\nDo NOT use TypeScript syntax — no type annotations, interfaces, or generics.\nDo NOT define named functions then call them — just write the arrow function body directly.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "description": "JavaScript async arrow function to execute"
        },
        "confirm": {
          "type": "string",
          "description": "Confirmation ID from a previous dry-run to execute pending write operations"
        }
      },
      "required": ["code"]
    }
  },
  {
    "name": "stats",
    "description": "Show token usage stats for this session.",
    "inputSchema": { "type": "object", "properties": {} }
  }
]
```

---

## Detailed Design

### 1. OpenAPI Spec Management

**Source specs:**
- Jira Cloud REST API v3:
  `https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json`
  (2.4 MB, ~400 endpoints)
- Confluence Cloud REST API v2:
  `https://developer.atlassian.com/cloud/confluence/swagger.v3.json`
  (~150 endpoints)

**Processing pipeline (build-time):**
1. Download both OpenAPI specs
2. Resolve all `$ref` references inline (with circular reference detection → `{ $circular: ref }`)
3. For each path, extract only: `summary`, `description`, `tags`, `parameters`, `requestBody`, `responses`
4. Strip non-essential metadata (x-atlassian-*, x-experimental, deprecated endpoints)
5. Extract endpoint categories/tags for discoverability listing in the `search` tool description
6. Store as embedded JSON files in the npm package (no runtime fetch needed)

> **Design decision:** No FTS5/SQLite index. Following Cloudflare's production pattern,
> the model writes JavaScript to iterate `spec.paths` directly. This is simpler, has no
> extra dependencies, and works for Cloudflare's 2,500+ endpoints — more than sufficient
> for Atlassian's ~550 endpoints. The model can use `.includes()`, regex, or tag filtering
> in its JS code for keyword search.

**Update cadence:** Weekly automated GitHub Action to re-download and rebuild.
Atlassian's API changes infrequently. The action opens a PR for review.

### 2. The `search` Tool

When the model calls `search`, it writes JavaScript that queries the spec:

```javascript
// Example: Find all Jira endpoints related to issue transitions
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.jira.paths)) {
    if (path.includes('transition')) {
      for (const [method, op] of Object.entries(methods)) {
        if (typeof op === 'object' && op.summary) {
          results.push({
            method: method.toUpperCase(),
            path,
            summary: op.summary,
            parameters: op.parameters?.map(p => p.name)
          });
        }
      }
    }
  }
  return results;
}
```

**Returns only matching endpoints** — the full spec never enters context.

The model can also drill into schemas:

```javascript
// Example: What fields can I set when creating a Jira issue?
async () => {
  const createOp = spec.jira.paths['/rest/api/3/issue']?.post;
  const body = createOp?.requestBody?.content?.['application/json']?.schema;
  const fields = body?.properties?.fields?.properties;
  return Object.keys(fields || {}).slice(0, 30);  // Top 30 field names
}
```

The `search` executor runs with **no network access** — the spec is embedded
in the sandbox context. This means `search` works fully offline.

### 3. The `execute` Tool

The SDK provides a hand-written type stub injected into the tool description (~600 tokens):

```typescript
// ATLASSIAN_TYPES — injected into the execute tool description
interface AtlassianRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

interface JqlResult {
  issues: Array<{ key: string; fields: Record<string, unknown> }>;
  total: number;
}

interface CqlResult {
  results: Array<{ id: string; title: string; type: string }>;
}

declare const atlassian: {
  jira: {
    /** Make a raw authenticated request to the Jira REST API */
    request(opts: AtlassianRequestOptions): Promise<unknown>;

    /** JQL search with field selection */
    jql(query: string, fields?: string[], maxResults?: number): Promise<JqlResult>;

    /** Get a single issue with specific fields */
    getIssue(key: string, fields?: string[]): Promise<unknown>;

    /** Get available transitions for an issue */
    getTransitions(key: string): Promise<Array<{ id: string; name: string }>>;

    /** Transition an issue to a new status */
    transition(key: string, transitionId: string, fields?: unknown): Promise<void>;

    /** Add a comment (plain text — auto-converts to ADF) */
    addComment(key: string, body: string): Promise<unknown>;

    /** Create an issue with sensible defaults */
    createIssue(project: string, type: string, fields: Record<string, unknown>): Promise<{ key: string }>;

    /** Update an issue's fields */
    updateIssue(key: string, fields: Record<string, unknown>): Promise<void>;

    /** Link two issues */
    linkIssues(inwardKey: string, outwardKey: string, linkType: string): Promise<void>;
  };

  confluence: {
    /** Make a raw authenticated request to the Confluence REST API */
    request(opts: AtlassianRequestOptions): Promise<unknown>;

    /** CQL search */
    cql(query: string, maxResults?: number): Promise<CqlResult>;

    /** Get page content as plain text (strips ADF) */
    getPageText(pageId: string): Promise<{ title: string; body: string }>;

    /** Get full page object */
    getPageById(pageId: string): Promise<unknown>;

    /** Create a page (plain text body — auto-converts to ADF) */
    createPage(spaceKey: string, title: string, body: string): Promise<{ id: string; title: string }>;

    /** Update a page (plain text body — auto-converts to ADF) */
    updatePage(pageId: string, title: string, body: string): Promise<void>;

    /** List accessible spaces */
    getSpaces(): Promise<Array<{ key: string; name: string }>>;

    /** Search within a space */
    searchInSpace(spaceKey: string, query: string): Promise<CqlResult>;
  };
};
```

**Usage example — the model chains multiple operations:**

```javascript
// "Find all P1 bugs assigned to my team, get their descriptions, and check
// if there's a Confluence runbook for each component"
async () => {
  // 1. Search Jira for P1 bugs
  const bugs = await atlassian.jira.jql(
    'project = CARE AND priority = P1 AND type = Bug AND status != Done',
    ['summary', 'components', 'assignee', 'status'],
    50
  );

  // 2. Extract unique components
  const components = [...new Set(
    bugs.issues.flatMap(i =>
      (i.fields.components || []).map(c => c.name)
    )
  )];

  // 3. Search Confluence for runbooks
  const runbooks = {};
  for (const comp of components) {
    const results = await atlassian.confluence.cql(
      `type = page AND title ~ "${comp} runbook"`,
      3
    );
    runbooks[comp] = results.results.map(r => ({
      title: r.title,
      id: r.id
    }));
  }

  // 4. Return only the summary — not 500KB of raw JSON
  return {
    bugCount: bugs.total,
    bugs: bugs.issues.map(i => ({
      key: i.key,
      summary: i.fields.summary,
      assignee: i.fields.assignee?.displayName,
      components: (i.fields.components || []).map(c => c.name)
    })),
    runbookCoverage: Object.fromEntries(
      components.map(c => [c, runbooks[c]?.length > 0 ? '✅' : '❌'])
    )
  };
}
```

**What enters context:** ~2KB of structured summary.
**What would have entered context without Code Mode:** 50 issue
objects × ~10KB each = ~500KB.

### 4. Sandbox Execution

**Primary: `isolated-vm` (secure V8 isolates for Node.js)**

```typescript
import ivm from 'isolated-vm';

class IsolatedVMExecutor implements Executor {
  async execute(code: string, context: Record<string, unknown>): Promise<ExecuteResult> {
    const isolate = new ivm.Isolate({ memoryLimit: 128 });
    const ivmContext = await isolate.createContext();
    const logs: string[] = [];

    // Inject console.log capture
    const jail = ivmContext.global;
    await jail.set('__logs', new ivm.ExternalCopy(logs).copyInto());
    await jail.set('console', {
      log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) => logs.push(`[warn] ${args.map(String).join(' ')}`),
      error: (...args: unknown[]) => logs.push(`[error] ${args.map(String).join(' ')}`)
    });

    // Inject SDK functions as references (callable from isolate)
    for (const [name, fn] of Object.entries(context)) {
      await jail.set(name, fn, { reference: true });
    }

    try {
      const fn = `(async () => { return await (${code})(); })()`;
      const result = await ivmContext.eval(fn, { timeout: 30000, promise: true });
      return { result, logs };
    } catch (err) {
      return { result: undefined, error: err.message, logs };
    } finally {
      isolate.dispose();
    }
  }
}
```

> **Design decision:** Using `isolated-vm` (real V8 isolates) instead of Node's `vm` module.
> Node.js docs explicitly warn: "The vm module is not a security mechanism. Do not use it
> to run untrusted code." The `vm2` package is deprecated and archived (2023) due to
> unfixable sandbox escapes. `isolated-vm` provides proper V8 isolate-level separation
> with no access to the host process, filesystem, or environment variables.
>
> This mirrors Cloudflare's approach of using V8 isolates via Workers, adapted for
> Node.js local execution.

**The `Executor` interface is generic** — additional executors can be built later
(Docker container, Cloudflare Workers, etc.) without changing the tool layer.

```typescript
interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

interface Executor {
  execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult>;
}
```

### 5. Authentication

The MCP server handles auth — the model never sees credentials.

```typescript
// Config passed at server startup via environment variables
interface AtlassianConfig {
  jira: {
    baseUrl: string;        // https://your-company.atlassian.net
    auth: {
      email: string;
      apiToken: string;
    } | {
      bearerToken: string;  // OAuth 2.0
    };
  };
  confluence: {
    baseUrl: string;        // https://your-company.atlassian.net/wiki
    auth: /* same as jira */;
  };
}
```

Auth is injected into the request proxy layer — outside the sandbox, never inside.
Generated code calls `atlassian.jira.request(...)` and the server's proxy function
adds auth headers automatically before making the HTTP request. This follows
Cloudflare's `GlobalOutbound` pattern where the token never enters the code isolate.

```typescript
// Request proxy (runs in host process, NOT in sandbox)
async function makeJiraRequest(opts: AtlassianRequestOptions): Promise<unknown> {
  const url = new URL(config.jira.baseUrl + opts.path);
  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };

  // Inject auth — never exposed to sandbox
  if ('apiToken' in config.jira.auth) {
    const token = Buffer.from(
      `${config.jira.auth.email}:${config.jira.auth.apiToken}`
    ).toString('base64');
    headers['Authorization'] = `Basic ${token}`;
  } else {
    headers['Authorization'] = `Bearer ${config.jira.auth.bearerToken}`;
  }

  if (opts.body) headers['Content-Type'] = 'application/json';

  const response = await fetch(url.toString(), {
    method: opts.method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jira API error ${response.status}: ${text}`);
  }

  return response.json();
}
```

### 6. Output Truncation

Simple character-based truncation, following Cloudflare's production approach.

```typescript
const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 6000;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;  // 24,000 chars

function truncateResponse(content: unknown): string {
  const text = typeof content === 'string'
    ? content
    : JSON.stringify(content, null, 2);

  if (text.length <= MAX_CHARS) return text;

  const truncated = text.slice(0, MAX_CHARS);
  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN);

  return `${truncated}\n\n--- TRUNCATED ---\nResponse was ~${estimatedTokens.toLocaleString()} tokens (limit: ${MAX_TOKENS.toLocaleString()}). Refine your code to return less data (select fewer fields, reduce maxResults, or filter in code).`;
}
```

> **Design decision:** Dropped intent-based filtering and in-memory knowledge base
> from the MVP. Cloudflare ships this exact simple truncation pattern in production
> for 2,500+ endpoints. The truncation message acts as a prompt to the model to write
> more targeted code. Smart filtering can be added in a future phase.

Both `search` and `execute` tool results go through this truncation.

### 7. ADF (Atlassian Document Format) Conversion

ADF is deeply nested JSON that represents rich text. A 500-word page can be
20KB in ADF vs 3KB in plain text. The server auto-converts ADF to markdown-like
plain text for output.

**Scope for MVP:** Support the top node types that cover ~95% of real content:
- `paragraph`, `heading` (h1-h6)
- `text` with marks (`strong`, `em`, `code`, `link`, `strike`)
- `bulletList`, `orderedList`, `listItem`
- `codeBlock` (with language)
- `blockquote`
- `table`, `tableRow`, `tableHeader`, `tableCell`
- `mention`, `emoji`, `hardBreak`

Unsupported node types are rendered as `[unsupported: nodeType]` rather than
silently dropped.

```typescript
function adfToText(adf: any): string {
  if (!adf || !adf.content) return '';
  return adf.content.map(node => renderNode(node)).join('\n\n');
}

function renderNode(node: any): string {
  switch (node.type) {
    case 'paragraph':
      return renderInline(node.content);
    case 'heading':
      return '#'.repeat(node.attrs?.level || 1) + ' ' + renderInline(node.content);
    case 'bulletList':
      return node.content.map(li => '- ' + renderNode(li)).join('\n');
    case 'orderedList':
      return node.content.map((li, i) => `${i + 1}. ` + renderNode(li)).join('\n');
    case 'listItem':
      return (node.content || []).map(renderNode).join('\n');
    case 'codeBlock':
      const lang = node.attrs?.language || '';
      return '```' + lang + '\n' + renderInline(node.content) + '\n```';
    case 'blockquote':
      return (node.content || []).map(n => '> ' + renderNode(n)).join('\n');
    case 'table':
      return renderTable(node);
    // ... other node types
    default:
      if (node.content) return (node.content || []).map(renderNode).join('');
      return node.text || `[unsupported: ${node.type}]`;
  }
}
```

### 8. Convenience Methods (Sugar Over Raw API)

These save the model from having to know Jira/Confluence API specifics.
All convenience methods include **auto-pagination** for list operations.

```typescript
// Jira conveniences — all implemented as functions in the host process
// and exposed to the sandbox via the atlassian proxy object

async function jiraJql(query: string, fields?: string[], maxResults: number = 50) {
  // Auto-paginate: Jira caps at 100 per request
  const pageSize = Math.min(maxResults, 100);
  let startAt = 0;
  let allIssues = [];

  while (allIssues.length < maxResults) {
    const result = await makeJiraRequest({
      method: 'GET',
      path: '/rest/api/3/search',
      query: {
        jql: query,
        fields: fields?.join(','),
        startAt: String(startAt),
        maxResults: String(pageSize),
      },
    });
    allIssues.push(...result.issues);
    if (allIssues.length >= result.total) break;
    startAt += pageSize;
  }

  // Auto-strip: convert ADF description to plain text
  for (const issue of allIssues) {
    if (issue.fields?.description && typeof issue.fields.description === 'object') {
      issue.fields.description = adfToText(issue.fields.description);
    }
  }

  return { issues: allIssues.slice(0, maxResults), total: allIssues.length };
}

// Full convenience method list:
// Jira:
//   jql(query, fields?, maxResults?)        — JQL search with field selection + auto-pagination
//   getIssue(key, fields?)                  — Single issue, selected fields, ADF auto-converted
//   getTransitions(key)                     — Available transitions for issue
//   transition(key, transitionId, fields?)  — Transition with optional fields
//   addComment(key, body)                   — Add comment (plain text → ADF)
//   createIssue(project, type, fields)      — Create with sensible defaults
//   updateIssue(key, fields)                — Update issue fields
//   linkIssues(inward, outward, linkType)   — Link two issues

// Confluence:
//   cql(query, maxResults?)                 — CQL search + auto-pagination
//   getPageText(pageId)                     — Page content as plain text (ADF stripped)
//   getPageById(pageId)                     — Full page object
//   createPage(spaceKey, title, body)       — Create page (plain text → ADF)
//   updatePage(pageId, title, body)         — Update page
//   getSpaces()                             — List accessible spaces
//   searchInSpace(spaceKey, query)          — Search within a space
```

### 9. Code Normalization

Following Cloudflare's approach, normalize LLM-generated code before execution
using AST parsing via `acorn`:

```typescript
import * as acorn from 'acorn';

function normalizeCode(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return 'async () => {}';

  try {
    const ast = acorn.parse(trimmed, { ecmaVersion: 'latest', sourceType: 'module' });

    // Already an arrow function — pass through
    if (ast.body.length === 1 && ast.body[0].type === 'ExpressionStatement') {
      const expr = ast.body[0].expression;
      if (expr.type === 'ArrowFunctionExpression') return trimmed;
    }

    // Last statement is expression → splice in return
    const last = ast.body[ast.body.length - 1];
    if (last?.type === 'ExpressionStatement') {
      const before = trimmed.slice(0, last.start);
      const exprText = trimmed.slice(last.expression.start, last.expression.end);
      return `async () => {\n${before}return (${exprText})\n}`;
    }

    return `async () => {\n${trimmed}\n}`;
  } catch {
    // Syntax error fallback — wrap and let the sandbox report the error
    return `async () => {\n${trimmed}\n}`;
  }
}
```

This handles common LLM code patterns: bare arrow functions, code blocks without
return statements, and syntax errors (fail gracefully in sandbox).

---

## Write-Side Confirmation Pattern

Read operations execute freely. Write operations require confirmation
before executing.

### How It Works

The `execute` tool detects write intent by inspecting the generated
code before running it. Any call to a mutating method triggers a
confirmation flow.

**Mutating methods detected:**
- `jira.createIssue()`, `jira.updateIssue()`, `jira.transition()`,
  `jira.addComment()`, `jira.linkIssues()`
- `confluence.createPage()`, `confluence.updatePage()`, `confluence.addComment()`
- `jira.request({ method: 'POST' | 'PUT' | 'DELETE', ... })`
- `confluence.request({ method: 'POST' | 'PUT' | 'DELETE', ... })`

**Detection approach:** Simple string/regex matching on the code string.
Check for method names and HTTP verbs in request calls. This is intentionally
lightweight — not a full AST analysis, since false positives (asking for
confirmation when not needed) are acceptable, while false negatives are not.

**Confirmation response:**

When write operations are detected, the sandbox runs the code in
**dry-run mode** — it resolves all read operations but pauses before
executing writes. It returns a preview:

```json
{
  "status": "confirmation_required",
  "preview": {
    "operations": [
      {
        "action": "CREATE_ISSUE",
        "target": "CARE project",
        "details": {
          "type": "Bug",
          "summary": "Login redirect fails on mobile Safari",
          "priority": "P1",
          "assignee": "jane.doe@carrot.com"
        }
      }
    ],
    "readResults": {
      "existingBugs": 3,
      "note": "3 similar bugs already exist in CARE (CARE-891, CARE-903, CARE-912)"
    }
  },
  "confirmationId": "abc123"
}
```

The model shows this to the engineer and asks for confirmation. On
approval, a follow-up `execute` call with `{ confirm: "abc123" }` runs
the writes.

**Safety benefits:**
- No accidental bulk updates (model writes `UPDATE` on 50 issues
  without engineer seeing it)
- De-duplication hints (server checks for similar existing issues
  before creating)
- Full preview of what will change before it changes

**Auto-confirm override:**
A **server-level environment variable** `AUTO_CONFIRM=true` skips the confirmation
flow. This is set at server startup, not in generated code.

> **Design decision:** Removed `// @auto-confirm` code comment pattern. Since the
> model generates the code, a prompt injection in a Jira issue description could
> cause the model to include the comment, bypassing safety. Making it a server
> config flag means only the engineer controls it.

---

## Token Budget Comparison

| Scenario | Current MCP | Code Mode MCP |
|----------|-------------|---------------|
| Tool definitions (per turn) | ~20K tokens | ~1.2K tokens |
| JQL search (20 issues) | ~100-500K tokens | ~2-5K tokens |
| Get single issue with comments | ~10-50K tokens | ~1-3K tokens |
| Confluence page read | ~20-100K tokens | ~1-3K tokens |
| Full session (45 min) | Context exhausted | ~15% used |
| **Total savings** | — | **90-98% reduction** |

---

## Token Savings Verification

The server includes built-in instrumentation to prove savings are real.

### `stats` Tool

Returns:

```json
{
  "session": {
    "uptime": "12.4 min",
    "totalCalls": 8
  },
  "context": {
    "tokensReturnedToContext": 4200,
    "tokensKeptInSandbox": 312000,
    "savingsRatio": "98.7%",
    "estimatedWithoutCodeMode": 316200
  },
  "byCall": [
    { "call": 1, "tool": "search",  "contextTokens": 180,  "sandboxTokens": 0 },
    { "call": 2, "tool": "execute", "contextTokens": 1200, "sandboxTokens": 148000 },
    { "call": 3, "tool": "execute", "contextTokens": 800,  "sandboxTokens": 52000 },
    { "call": 4, "tool": "execute", "contextTokens": 2020, "sandboxTokens": 112000 }
  ]
}
```

### How It Measures

- **`tokensReturnedToContext`**: Estimated token count (chars / 4) of what
  the sandbox returned to the model
- **`tokensKeptInSandbox`**: Estimated token count of raw API responses that
  were processed inside the sandbox but never entered context
- **`estimatedWithoutCodeMode`**: What the equivalent individual MCP tool calls
  would have cost: `(numTurns × toolDefinitionTokens) + totalRawResponseTokens`
- **`savingsRatio`**: `1 - (returnedToContext / estimatedWithoutCodeMode)`

---

## Error Handling

Following Cloudflare's pattern: errors bubble up from the sandbox and are
returned to the model for self-correction. No auto-retry, no partial results.

```typescript
// Sandbox execution result
interface ExecuteResult {
  result: unknown;        // Return value from the function
  error?: string;         // Error message if execution failed
  logs?: string[];        // console.log/warn/error output captured from sandbox
}

// MCP tool response on error
{
  content: [{ type: 'text', text: 'Error: Jira API error 400: JQL query syntax error near "PRJECT"' }],
  isError: true
}
```

The model sees the error message and can self-correct by writing new code.
Console output (from `console.log` in the sandbox) is included in error
responses for debugging context.

> **Design decision:** Keeping error handling simple for MVP. No partial results,
> no auto-retry of transient errors. Cloudflare's production server uses this
> exact pattern. Auto-retry of 429s can be added in Phase 3.

---

## Implementation Plan

### Phase 1: MVP (Week 1)

**Goal:** Working MCP server with `search` and `execute` for Jira.

1. **Day 1: Project scaffold + spec processing**
   - TypeScript MCP server using `@modelcontextprotocol/sdk`
   - Download and process Jira OpenAPI spec (resolve $refs, strip noise)
   - Embed processed spec as JSON in the package
   - Basic `search` tool — model can query the spec

2. **Day 2: Sandbox + execute tool**
   - `isolated-vm` executor with timeout (30s) and memory limit (128MB)
   - Auth proxy layer (injects credentials outside sandbox)
   - `atlassian.jira.request()` — raw authenticated requests
   - `atlassian.jira.jql()` — convenience JQL search with auto-pagination
   - Output truncation (24K char limit)

3. **Day 3: Convenience methods + ADF converter**
   - `getIssue`, `getTransitions`, `transition`, `addComment`, `createIssue`, `updateIssue`, `linkIssues`
   - ADF → plain text converter (top 10 node types)
   - Code normalization via acorn

4. **Day 4: Write confirmation + MCP integration**
   - Write detection and dry-run mode
   - Confirmation ID flow
   - Register as MCP server in Claude Code config
   - Test real workflows: "find my open tickets", "create a story",
     "transition CARE-123 to Done"

5. **Day 5: Stats + polish + documentation**
   - `stats` tool with token savings tracking
   - CLAUDE.md instructions for using the Code Mode server
   - README with setup, config, and examples
   - Error messages, timeout handling

### Phase 2: Confluence + Hardening (Week 2)

6. Add Confluence OpenAPI spec to `search`
7. Implement `atlassian.confluence.*` SDK methods
8. ADF → plain text conversion for page content
9. Plain text → ADF conversion for page creation
10. Integration tests with mocked HTTP responses

### Phase 3: Production Polish (Week 3)

11. Rate limiting (respect Atlassian API limits)
12. Response caching (60s TTL for frequently accessed data)
13. Auto-retry for transient errors (429, 503) with exponential backoff
14. Audit logging (track what the model queries)
15. npm package publication for team distribution
16. CI benchmark script for savings verification

---

## Integration with Current Atlassian MCP

This server **replaces** the existing Atlassian MCP, not sits
alongside it. The migration path:

1. Install the Code Mode server
2. Remove the old Atlassian MCP from Claude Code config
3. Engineers use the same natural language ("find my tickets", "update
   CARE-123")
4. Claude Code writes JavaScript instead of calling individual tools —
   transparent to the user

If there are specific tools in the current MCP that can't be
replicated (e.g., Compass-specific operations), keep those tools
active alongside Code Mode for a transition period.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Model writes bad JavaScript | `isolated-vm` sandbox with timeout (30s) and memory limit (128MB). Errors returned to model for self-correction. Code normalization handles common patterns. |
| Security: code accesses unintended data | `isolated-vm` provides real V8 isolate separation. No access to host filesystem, env vars, or `require()`. Auth scoped to user's Jira permissions. |
| API rate limits | Let Atlassian return 429s for MVP. Model sees error and self-corrects. Add built-in rate limiter in Phase 3. |
| OpenAPI spec changes break search | Weekly automated spec refresh via GitHub Action. Version pinning for stability. |
| Model doesn't know the Atlassian API | Convenience methods abstract common patterns. `search` tool lets it discover endpoints. Hand-written type definitions provide IDE-like guidance. Tool descriptions include examples. |
| ADF (Atlassian Document Format) is complex | Auto-convert to plain text. Cover top 10 node types for MVP (~95% of content). Unsupported types render as `[unsupported: type]`. |
| Large output exceeds context | Character-based truncation at ~6K tokens with actionable message to refine query. |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server framework |
| `isolated-vm` | V8 isolate sandbox for code execution |
| `acorn` | AST parsing for code normalization |
| `@apidevtools/json-schema-ref-parser` | Resolve OpenAPI $refs at build time |
| `undici` (or Node 18+ built-in `fetch`) | HTTP client for Atlassian API |

> **Removed from original spec:** `better-sqlite3` (no FTS5 index needed),
> `vm2` / `node:vm` (replaced by `isolated-vm`).

---

## Team Rollout & Multi-Agent Compatibility

### Shared MCP Config (Claude Code)

Check a `.mcp.json` into the repo root. Claude Code auto-discovers it:

```json
{
  "mcpServers": {
    "atlassian-codemode": {
      "command": "npx",
      "args": ["-y", "@carrot/atlassian-codemode"],
      "env": {
        "ATLASSIAN_URL": "https://your-company.atlassian.net",
        "ATLASSIAN_EMAIL": "${ATLASSIAN_EMAIL}",
        "ATLASSIAN_API_TOKEN": "${ATLASSIAN_API_TOKEN}"
      }
    }
  }
}
```

Engineers set two env vars (`ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`)
in their shell profile. The MCP config references them. No secrets in the repo.

### Shared MCP Config (OpenAI Codex)

```toml
[mcp_servers.atlassian-codemode]
command = "npx"
args = ["-y", "@carrot/atlassian-codemode"]

[mcp_servers.atlassian-codemode.env]
ATLASSIAN_URL = "https://your-company.atlassian.net"
```

### How It Runs Locally

```
┌─────────────────────────────────────────────────────┐
│  Engineer's Laptop                                   │
│                                                      │
│  ┌──────────────┐    stdio     ┌──────────────────┐ │
│  │ Claude Code   │◄───────────►│ MCP Server       │ │
│  │ or Codex      │  (stdin/    │ (Node.js process) │ │
│  │               │   stdout)   │                   │ │
│  └──────────────┘              │ • OpenAPI specs   │ │
│                                │   (embedded JSON) │ │
│                                │ • isolated-vm     │ │
│                                │   sandbox         │ │
│                                │ • HTTP client ────┼─┼──► Atlassian Cloud
│                                └──────────────────┘ │     (HTTPS, API token)
└─────────────────────────────────────────────────────┘
```

**Lifecycle:**
1. Engineer opens Claude Code / Codex
2. Agent reads `.mcp.json`, spawns `npx -y @carrot/atlassian-codemode`
3. Server loads pre-bundled OpenAPI specs, connects via stdin/stdout
4. Server lives for the duration of the session
5. Session ends → child process dies. No cleanup needed.

**Resource footprint:**
- Memory: ~80-120MB (Node process + isolated-vm + embedded specs)
- CPU: Near-zero when idle. Brief spikes during code execution.
- Network: Only outbound HTTPS to `your-company.atlassian.net`.
- Disk: ~15MB cached npm package

**First-run setup (one time):**
```bash
export ATLASSIAN_EMAIL="jane.doe@carrot.com"
export ATLASSIAN_API_TOKEN="your-api-token"
```

Get an API token at: https://id.atlassian.com/manage-profile/security/api-tokens

**Offline behavior:** If Atlassian is down, API calls fail with clear error
messages. The `search` tool works fully offline since specs are bundled.

### Compatibility Matrix

| Feature | Claude Code | OpenAI Codex | Cursor | VS Code + Copilot |
|---------|------------|--------------|--------|-------------------|
| MCP stdio transport | Yes | Yes | Yes | Yes |
| Project-scoped config | `.mcp.json` | `.codex/config.toml` | `.cursor/mcp.json` | `.vscode/mcp.json` |
| Env var passthrough | Yes | Yes | Yes | Yes |

The server is **agent-agnostic** — standard MCP stdio server. Any client
that speaks MCP can use it.

### Rollout Playbook

**Week 1: Build + internal alpha**
- 1-2 engineers test the MVP
- Run benchmark, capture before/after numbers

**Week 2: Team beta**
- Merge `.mcp.json` to main repos
- Slack announcement with setup instructions (2 env vars)

**Week 3: Default on**
- Add to onboarding docs
- Remove old Atlassian MCP from recommended config

---

## Testing Strategy

### Unit Tests (no Atlassian credentials needed)
- **Spec processor:** Test $ref resolution, circular ref handling, metadata stripping
- **ADF converter:** Test each node type conversion with fixture ADF documents
- **Code normalizer:** Test arrow function passthrough, expression wrapping, syntax error fallback
- **Write detector:** Test detection of mutating method calls and HTTP verbs
- **Truncation:** Test character limit, truncation message

### Integration Tests (mocked HTTP)
- **SDK methods:** Record real Atlassian API responses as fixtures, replay in tests
- **Convenience methods:** Test JQL pagination, field selection, ADF auto-conversion
- **Error handling:** Test 400, 401, 403, 404, 429 responses
- **Sandbox execution:** Test code execution, timeout, memory limit, console capture

### E2E Tests (optional, requires credentials)
- Against a real Jira Cloud instance (test project)
- Standard workflows: search, create, update, transition

---

## Decisions (Confirmed)

1. **Compass:** Not used. Excluded from scope.
2. **Write operations:** Read + write from day 1. Gated by confirmation flow.
3. **Multi-site:** Single Atlassian instance.
4. **Auth:** API token (email + token pair).
5. **Where to host:** Run locally as a child process of Claude Code / Codex.
6. **Open source:** TBD. This would be genuinely useful to the community.
   No existing Atlassian Code Mode implementation exists.
7. **Sandbox:** `isolated-vm` (V8 isolates). Not `node:vm`.
8. **Spec indexing:** Embedded JSON, no FTS5/SQLite. Model writes JS to iterate.
9. **Output handling:** Simple character-based truncation at ~6K tokens.
10. **Auto-confirm:** Server config flag only. Never in generated code.

---

## References

- Cloudflare Code Mode blog post: https://blog.cloudflare.com/code-mode-mcp/
- Cloudflare Code Mode SDK source: https://github.com/cloudflare/agents/tree/main/packages/codemode
- Cloudflare MCP Server source: https://github.com/cloudflare/mcp
- Cloudflare Code Mode SDK docs: https://developers.cloudflare.com/agents/api-reference/codemode/
- Context Mode: https://github.com/mksglu/claude-context-mode
- Anthropic "Code Execution with MCP": https://www.anthropic.com/engineering/code-execution-with-mcp
- Atlassian MCP (official): https://github.com/atlassian/atlassian-mcp-server
- Atlassian MCP (sooperset): https://github.com/sooperset/mcp-atlassian
- Jira Cloud REST API v3: https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/
- Jira OpenAPI spec: https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json
- Confluence Cloud REST API v2: https://developer.atlassian.com/cloud/confluence/rest/v2/
- MCP specification: https://spec.modelcontextprotocol.io/
- isolated-vm: https://github.com/nicolo-ribaudo/isolated-vm
