#!/usr/bin/env node

/**
 * CLI entry point for the Atlassian Code Mode MCP Server.
 *
 * Runs as a stdio MCP server — spawned by Claude Code, Codex, Cursor, etc.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main() {
  try {
    const config = loadConfig();
    const server = await createServer(config);
    const transport = new StdioServerTransport();

    console.error('[atlassian-codemode] Starting MCP server via stdio...');
    await server.connect(transport);
    console.error('[atlassian-codemode] Server connected. Ready for requests.');
  } catch (err) {
    console.error(`[atlassian-codemode] Fatal error: ${err}`);
    process.exit(1);
  }
}

main();
