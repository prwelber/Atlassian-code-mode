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

export function createRequestFn(config: AtlassianConfig) {
  return async (opts: AtlassianRequestOptions): Promise<unknown> => {
    const url = new URL(config.baseUrl + opts.path);

    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    // Inject auth — never exposed to sandbox
    if (isBasicAuth(config.auth)) {
      const token = Buffer.from(
        `${config.auth.email}:${config.auth.apiToken}`
      ).toString('base64');
      headers['Authorization'] = `Basic ${token}`;
    } else {
      headers['Authorization'] = `Bearer ${config.auth.bearerToken}`;
    }

    if (opts.body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url.toString(), {
      method: opts.method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Atlassian API error ${response.status}: ${text.slice(0, 500)}`
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
