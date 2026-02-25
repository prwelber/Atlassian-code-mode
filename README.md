# Atlassian Code Mode MCP Server

2 tools instead of 20+ — 90-98% token savings for Atlassian workflows in Claude Code.

## The Problem

Traditional Atlassian MCP servers register 20+ individual tools (`jira_create_issue`, `jira_update_issue`, `confluence_create_page`, etc.), each consuming 15-25K tokens per turn. API responses are massive — a single Jira issue can be 10-50KB, and JQL searches 100-500KB per result set. After 30 minutes of Atlassian work, sessions become sluggish as raw API data crowds out useful context.

## The Solution

Inspired by [Cloudflare's Code Mode pattern](https://blog.cloudflare.com/mcp-code-mode), this MCP server exposes just **3 tools** (~1,200 tokens total):

| Tool | Purpose |
|------|---------|
| `search` | Search Jira (~400) and Confluence (~150) OpenAPI endpoints from an embedded, pre-resolved spec |
| `execute` | Run JavaScript against live Atlassian APIs in a sandboxed V8 isolate, returning only the data you need |
| `stats` | View session token savings and usage statistics |

Claude writes small JavaScript functions that run inside a secure sandbox, filtering API responses down to just the fields needed before they enter the context window.

## Quick Start

### Prerequisites

- Node.js 18+
- An Atlassian account with an [API token](https://id.atlassian.com/manage-profile/security/api-tokens)

### Install

```bash
npm install
```

### Configure

```bash
export ATLASSIAN_URL="https://your-company.atlassian.net"
export ATLASSIAN_EMAIL="you@company.com"
export ATLASSIAN_API_TOKEN="your-api-token"
```

### Run

```bash
# Development
npm run dev

# Production
npm run build && npm start
```

### Process OpenAPI Specs (optional)

Downloads and processes Jira & Confluence OpenAPI specs so the `search` tool can look up endpoints:

```bash
npm run process-specs
```

## Usage with Codex

Add to your Codex MCP config (`codex.json` or equivalent):

```json
{
  "mcpServers": {
    "atlassian-codemode": {
      "command": "npx",
      "args": ["-y", "@prwelber/atlassian-codemode"],
      "env": {
        "ATLASSIAN_URL": "https://your-company.atlassian.net",
        "ATLASSIAN_EMAIL": "you@company.com",
        "ATLASSIAN_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

**Migrating from JIRA_\* env vars?** Map them like this:

| Old variable | New variable |
|---|---|
| `JIRA_URL` / `JIRA_BASE_URL` | `ATLASSIAN_URL` |
| `JIRA_EMAIL` / `JIRA_USER_EMAIL` | `ATLASSIAN_EMAIL` |
| `JIRA_API_TOKEN` / `JIRA_TOKEN` | `ATLASSIAN_API_TOKEN` |
| *(OAuth / PAT)* | `ATLASSIAN_BEARER_TOKEN` |

## Usage with Claude Code

Add to your Claude Code MCP config (`~/.claude/settings.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "atlassian-codemode": {
      "command": "npx",
      "args": ["-y", "@prwelber/atlassian-codemode"],
      "env": {
        "ATLASSIAN_URL": "https://your-company.atlassian.net",
        "ATLASSIAN_EMAIL": "you@company.com",
        "ATLASSIAN_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

Then interact naturally:

**Discover endpoints:**
> "Find the endpoint for transitioning a Jira issue"

Claude searches the embedded OpenAPI spec and returns matching endpoints.

**Execute API calls:**
> "Show me all open bugs in the PROJ project"

Claude writes and executes a sandboxed function:
```javascript
async () => {
  const issues = await atlassian.jira.jql(
    'project = PROJ AND type = Bug AND status != Done',
    ['summary', 'status', 'assignee']
  );
  return issues.map(i => ({
    key: i.key,
    summary: i.fields.summary,
    status: i.fields.status?.name,
    assignee: i.fields.assignee?.displayName
  }));
}
```

Only the filtered result enters your context — not the full API response.

**Write operations** trigger a confirmation flow. Claude detects POST/PUT/DELETE calls and asks you to confirm before executing.

## Available SDK Methods

### Jira

| Method | Description |
|--------|-------------|
| `jira.jql(query, fields?, maxResults?)` | Auto-paginated JQL search (falls back to `/search/jql` on HTTP 410) |
| `jira.jqlV2(query, fields?, maxResults?)` | JQL search using `/search/jql` endpoint (cursor-based pagination) |
| `jira.getIssue(key, fields?)` | Fetch a single issue |
| `jira.createIssue(project, type, fields)` | Create an issue |
| `jira.updateIssue(key, fields)` | Update an issue |
| `jira.getTransitions(key)` | Get available transitions |
| `jira.transition(key, transitionId, fields?)` | Transition an issue |
| `jira.addComment(key, body)` | Add a comment |
| `jira.linkIssues(inward, outward, type)` | Link two issues |
| `jira.request(opts)` | Raw HTTP request |

### Confluence

| Method | Description |
|--------|-------------|
| `confluence.cql(query, maxResults?)` | CQL search |
| `confluence.getPageText(pageId)` | Get page as plain text |
| `confluence.getPageById(pageId)` | Full page details |
| `confluence.createPage(spaceKey, title, body)` | Create a page |
| `confluence.updatePage(pageId, title, body)` | Update a page |
| `confluence.getSpaces()` | List all spaces |
| `confluence.searchInSpace(spaceKey, query)` | Search within a space |
| `confluence.request(opts)` | Raw HTTP request |

All methods automatically handle ADF (Atlassian Document Format) conversion — descriptions and page bodies are returned as plain text and accepted as plain text.

### Response Helpers

These functions are available in sandbox code to keep responses under the 6,000-token limit:

| Helper | Description |
|--------|-------------|
| `select(items, ['key', 'fields.summary'])` | Pick dot-paths from each item in an array |
| `limitFields(items, ['key', 'title'])` | Pick top-level keys from each item |
| `estimateSize(value)` | Returns `{ tokens, chars }` — check before returning |

```javascript
async () => {
  const result = await atlassian.jira.jql('project = PROJ', ['summary', 'status'], 50);
  // Check size before returning
  if (estimateSize(result).tokens > 3000) {
    return select(result.issues, ['key', 'fields.summary', 'fields.status.name']);
  }
  return result;
}
```

## Security

- **V8 isolate sandboxing** via `isolated-vm` — code runs in a disposable isolate with a 128MB memory limit and 30-second timeout
- **Credentials never enter the sandbox** — authentication headers are injected by the host process
- **Write confirmation flow** — destructive operations require explicit user confirmation (disable with `AUTO_CONFIRM=true`)
- `isolated-vm` is an **optional dependency** — if it can't compile, the server falls back to Node.js `vm` module with a detailed warning. To install it:
  - **Linux:** `sudo apt install build-essential && npm install isolated-vm`
  - **macOS:** `xcode-select --install && npm install isolated-vm`
  - **Alpine:** `apk add python3 make g++ && npm install isolated-vm`
  - The `vm` fallback works for development but is **not a security boundary** — use `isolated-vm` in production

## Project Structure

```
src/
├── cli.ts                  # Stdio MCP server entry point
├── server.ts               # Core tool implementations
├── config.ts               # Environment variable loader
├── sdk/
│   ├── jira.ts             # Jira convenience SDK
│   ├── confluence.ts       # Confluence convenience SDK
│   └── request.ts          # Authenticated HTTP layer
├── sandbox/
│   └── executor.ts         # V8 isolate & Node VM executors
├── spec/
│   ├── loader.ts           # Embedded OpenAPI spec loader
│   └── processor.ts        # $ref resolution & cleanup
├── tools/
│   └── descriptions.ts     # Tool description text
└── utils/
    ├── adf.ts              # ADF <-> plain text conversion
    ├── truncate.ts         # Output truncation (6000 token limit)
    ├── write-detector.ts   # Write operation detection
    └── normalize-code.ts   # Code normalization via AST
```

## Testing

```bash
npm test            # Run all tests
npm run test:watch  # Watch mode
```

## Configuration Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `ATLASSIAN_URL` | Yes | Your Atlassian instance URL |
| `ATLASSIAN_EMAIL` | Yes* | Email for basic auth |
| `ATLASSIAN_API_TOKEN` | Yes* | API token for basic auth |
| `ATLASSIAN_BEARER_TOKEN` | Alt | Bearer token (alternative to email + API token) |
| `AUTO_CONFIRM` | No | Set to `true` to skip write confirmations |

\* Not required if using `ATLASSIAN_BEARER_TOKEN` instead.

## License

MIT
