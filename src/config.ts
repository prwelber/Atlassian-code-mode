/**
 * Configuration loader.
 *
 * Reads from environment variables:
 *   ATLASSIAN_URL       — Base URL (e.g. https://your-company.atlassian.net)
 *   ATLASSIAN_EMAIL     — User email for API token auth
 *   ATLASSIAN_API_TOKEN — API token from https://id.atlassian.com/manage-profile/security/api-tokens
 *   AUTO_CONFIRM        — Set to "true" to skip write confirmations
 */

import type { ServerConfig } from './types.js';

export function loadConfig(): ServerConfig {
  const baseUrl = process.env.ATLASSIAN_URL;
  if (!baseUrl) {
    throw new Error(
      'ATLASSIAN_URL environment variable is required.\n' +
        'Example: export ATLASSIAN_URL="https://your-company.atlassian.net"'
    );
  }

  const email = process.env.ATLASSIAN_EMAIL;
  const apiToken = process.env.ATLASSIAN_API_TOKEN;

  if (!email || !apiToken) {
    throw new Error(
      'ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN environment variables are required.\n' +
        'Get an API token at: https://id.atlassian.com/manage-profile/security/api-tokens'
    );
  }

  // Normalize URL — remove trailing slash
  const normalizedUrl = baseUrl.replace(/\/+$/, '');

  const auth = { email, apiToken };

  return {
    jira: {
      baseUrl: normalizedUrl,
      auth,
    },
    confluence: {
      baseUrl: normalizedUrl,
      auth,
    },
    autoConfirm: process.env.AUTO_CONFIRM === 'true',
  };
}
