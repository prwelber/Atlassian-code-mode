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

## Usage with Claude Code

Add this server to your MCP configuration, then interact naturally:

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
| `jira.jql(query, fields?, maxResults?)` | Auto-paginated JQL search |
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

## Security

- **V8 isolate sandboxing** via `isolated-vm` — code runs in a disposable isolate with a 128MB memory limit and 30-second timeout
- **Credentials never enter the sandbox** — authentication headers are injected by the host process
- **Write confirmation flow** — destructive operations require explicit user confirmation (disable with `AUTO_CONFIRM=true`)
- Falls back to Node.js `vm` module if `isolated-vm` is unavailable

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
