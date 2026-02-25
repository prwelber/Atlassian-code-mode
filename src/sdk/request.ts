/**
 * Authenticated request proxy for Atlassian APIs.
 *
 * Auth is injected here — outside the sandbox, never inside.
 * This follows Cloudflare's GlobalOutbound pattern where the token
 * never enters the code isolate.
 */

import type {
  AtlassianConfig,
  AtlassianRequestOptions,
  AtlassianAuthBasic,
} from '../types.js';

function isBasicAuth(auth: AtlassianConfig['auth']): auth is AtlassianAuthBasic {
  return 'email' in auth && 'apiToken' in auth;
}

/**
 * Build authenticated request headers for the given config.
 */
function buildHeaders(config: AtlassianConfig, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (isBasicAuth(config.auth)) {
    const token = Buffer.from(
      `${config.auth.email}:${config.auth.apiToken}`
    ).toString('base64');
    headers['Authorization'] = `Basic ${token}`;
  } else {
    headers['Authorization'] = `Bearer ${config.auth.bearerToken}`;
  }

  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }

  return headers;
}

/**
 * Build a full URL from config + request options.
 */
function buildUrl(config: AtlassianConfig, opts: AtlassianRequestOptions): string {
  const url = new URL(config.baseUrl + opts.path);

  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url.toString();
}

/**
 * Actionable hints for common HTTP error codes.
 */
const ERROR_HINTS: Record<number, string> = {
  401: 'Check your ATLASSIAN_API_TOKEN and ATLASSIAN_EMAIL — the current credentials were rejected.',
  403: 'Your API token lacks permission for this resource. Check project permissions or use an admin token.',
  404: 'Resource not found. Verify the issue key, page ID, or API path is correct.',
  410: 'This endpoint is deprecated. Use /rest/api/3/search/jql (cursor-based) instead of /rest/api/3/search.',
  429: 'Rate limited by Atlassian. Wait a moment and retry, or reduce request frequency.',
};

export function createRequestFn(config: AtlassianConfig) {
  return async (opts: AtlassianRequestOptions): Promise<unknown> => {
    const url = buildUrl(config, opts);
    const headers = buildHeaders(config, !!opts.body);

    const response = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      const hint = ERROR_HINTS[response.status];
      const hintSuffix = hint ? `\nHint: ${hint}` : '';
      throw new Error(
        `Atlassian API error ${response.status}: ${text.slice(0, 500)}${hintSuffix}`
      );
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }

    // Some endpoints return no content (204)
    if (response.status === 204) {
      return undefined;
    }

    return response.text();
  };
}

/**
 * Raw request function that returns the Response object directly.
 * Used by SDK methods that need to inspect the status code (e.g. 410 fallback).
 */
export function createRawRequestFn(config: AtlassianConfig) {
  return async (opts: AtlassianRequestOptions): Promise<Response> => {
    const url = buildUrl(config, opts);
    const headers = buildHeaders(config, !!opts.body);

    return fetch(url, {
      method: opts.method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  };
}
