/**
 * Core type definitions for the Atlassian Code Mode MCP Server.
 */

// --- Executor interface ---

export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

export interface Executor {
  execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult>;
}

// --- Atlassian configuration ---

export interface AtlassianAuthBasic {
  email: string;
  apiToken: string;
}

export interface AtlassianAuthBearer {
  bearerToken: string;
}

export type AtlassianAuth = AtlassianAuthBasic | AtlassianAuthBearer;

export interface AtlassianConfig {
  baseUrl: string; // e.g. https://your-company.atlassian.net
  auth: AtlassianAuth;
}

export interface ServerConfig {
  jira: AtlassianConfig;
  confluence: AtlassianConfig;
  autoConfirm?: boolean;
}

// --- Request types ---

export interface AtlassianRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

// --- Stats tracking ---

export interface CallStats {
  call: number;
  tool: 'search' | 'execute';
  contextTokens: number;
  sandboxTokens: number;
  timestamp: number;
}

export interface SessionStats {
  startTime: number;
  calls: CallStats[];
}

// --- Write confirmation ---

export interface PendingWrite {
  id: string;
  code: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  preview: WritePreview;
  createdAt: number;
}

export interface WriteOperation {
  action: string;
  target: string;
  details: Record<string, unknown>;
}

export interface WritePreview {
  operations: WriteOperation[];
  readResults?: Record<string, unknown>;
}
