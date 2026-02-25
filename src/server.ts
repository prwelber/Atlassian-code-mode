/**
 * Atlassian Code Mode MCP Server.
 *
 * Exposes 3 tools: search, execute, stats.
 * Replaces 20+ individual Atlassian MCP tools with ~1,200 tokens
 * of tool definitions, achieving 90-98% token savings.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type {
  ServerConfig,
  SessionStats,
  CallStats,
  PendingWrite,
  Executor,
} from './types.js';
import { loadSpecs, type SpecData } from './spec/loader.js';
import { createExecutor } from './sandbox/executor.js';
import { SearchExecutor } from './sandbox/executor.js';
import { createJiraSdk } from './sdk/jira.js';
import { createConfluenceSdk } from './sdk/confluence.js';
import { truncateResponse, estimateTokens } from './utils/truncate.js';
import { normalizeCode } from './utils/normalize-code.js';
import {
  detectWriteOperations,
  describeWriteOperations,
} from './utils/write-detector.js';
import {
  buildSearchDescription,
  buildExecuteDescription,
} from './tools/descriptions.js';

export async function createServer(config: ServerConfig): Promise<McpServer> {
  const server = new McpServer({
    name: 'atlassian-codemode',
    version: '0.1.0',
  });

  // --- Load specs ---
  const specs: SpecData = loadSpecs();

  // --- Create executor ---
  const executor = await createExecutor();
  const searchExecutor = new SearchExecutor({
    jira: specs.jira,
    confluence: specs.confluence,
  });

  // --- Create SDKs ---
  const jiraSdk = createJiraSdk(config.jira);
  const confluenceSdk = createConfluenceSdk(config.confluence);

  // --- Build tool function map for the sandbox ---
  function buildToolFns(): Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  > {
    return {
      // Jira methods
      'jira.request': async (args: unknown) =>
        jiraSdk.request(args as Parameters<typeof jiraSdk.request>[0]),
      'jira.jql': async (args: unknown) => {
        const a = args as [string, string[]?, number?];
        return jiraSdk.jql(a[0], a[1], a[2]);
      },
      'jira.getIssue': async (args: unknown) => {
        const a = args as [string, string[]?];
        return jiraSdk.getIssue(a[0], a[1]);
      },
      'jira.getTransitions': async (args: unknown) => {
        const a = args as [string];
        return jiraSdk.getTransitions(a[0]);
      },
      'jira.transition': async (args: unknown) => {
        const a = args as [string, string, unknown?];
        return jiraSdk.transition(a[0], a[1], a[2]);
      },
      'jira.addComment': async (args: unknown) => {
        const a = args as [string, string];
        return jiraSdk.addComment(a[0], a[1]);
      },
      'jira.createIssue': async (args: unknown) => {
        const a = args as [string, string, Record<string, unknown>];
        return jiraSdk.createIssue(a[0], a[1], a[2]);
      },
      'jira.updateIssue': async (args: unknown) => {
        const a = args as [string, Record<string, unknown>];
        return jiraSdk.updateIssue(a[0], a[1]);
      },
      'jira.linkIssues': async (args: unknown) => {
        const a = args as [string, string, string];
        return jiraSdk.linkIssues(a[0], a[1], a[2]);
      },

      // Confluence methods
      'confluence.request': async (args: unknown) =>
        confluenceSdk.request(
          args as Parameters<typeof confluenceSdk.request>[0]
        ),
      'confluence.cql': async (args: unknown) => {
        const a = args as [string, number?];
        return confluenceSdk.cql(a[0], a[1]);
      },
      'confluence.getPageText': async (args: unknown) => {
        const a = args as [string];
        return confluenceSdk.getPageText(a[0]);
      },
      'confluence.getPageById': async (args: unknown) => {
        const a = args as [string];
        return confluenceSdk.getPageById(a[0]);
      },
      'confluence.createPage': async (args: unknown) => {
        const a = args as [string, string, string];
        return confluenceSdk.createPage(a[0], a[1], a[2]);
      },
      'confluence.updatePage': async (args: unknown) => {
        const a = args as [string, string, string];
        return confluenceSdk.updatePage(a[0], a[1], a[2]);
      },
      'confluence.getSpaces': async () => confluenceSdk.getSpaces(),
      'confluence.searchInSpace': async (args: unknown) => {
        const a = args as [string, string];
        return confluenceSdk.searchInSpace(a[0], a[1]);
      },
    };
  }

  // --- Session stats ---
  const stats: SessionStats = {
    startTime: Date.now(),
    calls: [],
  };

  // --- Pending write confirmations ---
  const pendingWrites = new Map<string, PendingWrite>();

  // --- Register tools ---

  // 1. Search tool
  server.registerTool(
    'search',
    {
      description: buildSearchDescription(
        specs.jira.endpointCount,
        specs.confluence.endpointCount
      ),
      inputSchema: {
        code: z
          .string()
          .describe('JavaScript async arrow function to search the OpenAPI spec'),
      },
    },
    async ({ code }) => {
      try {
        const result = await searchExecutor.execute(code, {});
        const responseText = truncateResponse(
          result.error ? { error: result.error, logs: result.logs } : result.result
        );

        // Track stats
        const contextTokens = estimateTokens(responseText);
        stats.calls.push({
          call: stats.calls.length + 1,
          tool: 'search',
          contextTokens,
          sandboxTokens: 0,
          timestamp: Date.now(),
        });

        if (result.error) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${result.error}${result.logs?.length ? '\n\nConsole:\n' + result.logs.join('\n') : ''}` }],
            isError: true,
          };
        }

        return { content: [{ type: 'text' as const, text: responseText }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  // 2. Execute tool
  server.registerTool(
    'execute',
    {
      description: buildExecuteDescription(),
      inputSchema: {
        code: z
          .string()
          .describe('JavaScript async arrow function to execute'),
        confirm: z
          .string()
          .optional()
          .describe(
            'Confirmation ID from a previous dry-run to execute pending write operations'
          ),
      },
    },
    async ({ code, confirm }) => {
      const toolFns = buildToolFns();

      // Handle confirmation of a pending write
      if (confirm) {
        const pending = pendingWrites.get(confirm);
        if (!pending) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Confirmation ID "${confirm}" not found or expired.`,
              },
            ],
            isError: true,
          };
        }

        pendingWrites.delete(confirm);

        // Execute the original code (writes are now allowed)
        try {
          const result = await executor.execute(pending.code, toolFns);
          const responseText = truncateResponse(
            result.error
              ? { error: result.error, logs: result.logs }
              : result.result
          );

          const contextTokens = estimateTokens(responseText);
          stats.calls.push({
            call: stats.calls.length + 1,
            tool: 'execute',
            contextTokens,
            sandboxTokens: 0,
            timestamp: Date.now(),
          });

          if (result.error) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
              isError: true,
            };
          }

          return { content: [{ type: 'text' as const, text: responseText }] };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: 'text' as const, text: `Error: ${msg}` }],
            isError: true,
          };
        }
      }

      // Check for write operations
      if (!config.autoConfirm && detectWriteOperations(code)) {
        const confirmationId = crypto.randomUUID();
        const writeOps = describeWriteOperations(code);

        pendingWrites.set(confirmationId, {
          id: confirmationId,
          code: normalizeCode(code),
          fns: toolFns,
          preview: {
            operations: writeOps.map((op) => ({
              action: op,
              target: 'Atlassian',
              details: {},
            })),
          },
          createdAt: Date.now(),
        });

        // Clean up old pending writes (older than 5 minutes)
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        for (const [id, pw] of pendingWrites) {
          if (pw.createdAt < fiveMinAgo) pendingWrites.delete(id);
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'confirmation_required',
                  message:
                    'This code contains write operations. Please confirm before executing.',
                  operations: writeOps,
                  code: code.slice(0, 500),
                  confirmationId,
                  hint: `To execute, call this tool again with confirm: "${confirmationId}"`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Execute code (read-only or auto-confirm mode)
      try {
        const result = await executor.execute(
          normalizeCode(code),
          toolFns
        );

        // Estimate sandbox tokens (raw API data that didn't enter context)
        const rawResultSize = JSON.stringify(result.result || '').length;
        const responseText = truncateResponse(
          result.error
            ? { error: result.error, logs: result.logs }
            : result.result
        );
        const contextTokens = estimateTokens(responseText);
        const sandboxTokens = Math.max(
          0,
          estimateTokens(String(rawResultSize)) - contextTokens
        );

        stats.calls.push({
          call: stats.calls.length + 1,
          tool: 'execute',
          contextTokens,
          sandboxTokens: Math.ceil(rawResultSize / 4),
          timestamp: Date.now(),
        });

        if (result.error) {
          const logCtx = result.logs?.length
            ? `\n\nConsole:\n${result.logs.join('\n')}`
            : '';
          return {
            content: [
              { type: 'text' as const, text: `Error: ${result.error}${logCtx}` },
            ],
            isError: true,
          };
        }

        return { content: [{ type: 'text' as const, text: responseText }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  // 3. Stats tool
  server.registerTool(
    'stats',
    {
      description: 'Show token usage stats for this session.',
      inputSchema: {},
    },
    async () => {
      const uptimeMs = Date.now() - stats.startTime;
      const uptimeMin = (uptimeMs / 60000).toFixed(1);

      const totalContextTokens = stats.calls.reduce(
        (sum, c) => sum + c.contextTokens,
        0
      );
      const totalSandboxTokens = stats.calls.reduce(
        (sum, c) => sum + c.sandboxTokens,
        0
      );

      // Estimate what it would have cost without Code Mode:
      // ~20K tokens per turn for tool definitions + raw response tokens
      const toolDefTokensPerTurn = 20000;
      const estimatedWithout =
        stats.calls.length * toolDefTokensPerTurn +
        totalContextTokens +
        totalSandboxTokens;

      const savingsRatio =
        estimatedWithout > 0
          ? ((1 - totalContextTokens / estimatedWithout) * 100).toFixed(1)
          : '0';

      const response = {
        session: {
          uptime: `${uptimeMin} min`,
          totalCalls: stats.calls.length,
        },
        context: {
          tokensReturnedToContext: totalContextTokens,
          tokensKeptInSandbox: totalSandboxTokens,
          savingsRatio: `${savingsRatio}%`,
          estimatedWithoutCodeMode: estimatedWithout,
        },
        byCall: stats.calls.map((c) => ({
          call: c.call,
          tool: c.tool,
          contextTokens: c.contextTokens,
          sandboxTokens: c.sandboxTokens,
        })),
      };

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    }
  );

  return server;
}
