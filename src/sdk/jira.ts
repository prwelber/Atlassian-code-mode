/**
 * Jira convenience methods.
 *
 * These wrap the raw request function with Jira-specific logic:
 * field selection, auto-pagination, ADF conversion, etc.
 */

import type { AtlassianConfig, AtlassianRequestOptions } from '../types.js';
import { createRequestFn, createRawRequestFn } from './request.js';
import { adfToText, textToAdf } from '../utils/adf.js';

export function createJiraSdk(config: AtlassianConfig) {
  const request = createRequestFn(config);
  const rawRequest = createRawRequestFn(config);

  async function jiraRequest(opts: AtlassianRequestOptions): Promise<unknown> {
    return request(opts);
  }

  /**
   * Convert ADF fields to plain text in-place on an array of issues.
   */
  function convertAdfFields(
    issues: Array<{ key: string; fields: Record<string, unknown> }>
  ): void {
    for (const issue of issues) {
      if (
        issue.fields?.description &&
        typeof issue.fields.description === 'object'
      ) {
        issue.fields.description = adfToText(issue.fields.description);
      }
      if (issue.fields?.comment && typeof issue.fields.comment === 'object') {
        const commentField = issue.fields.comment as {
          comments?: Array<{ body?: unknown; author?: { displayName?: string } }>;
        };
        if (commentField.comments) {
          issue.fields.comment = commentField.comments.map((c) => ({
            author: c.author?.displayName,
            body: typeof c.body === 'object' ? adfToText(c.body) : c.body,
          }));
        }
      }
    }
  }

  /**
   * Paginated JQL search using the newer /rest/api/3/search/jql endpoint
   * with cursor-based (nextPageToken) pagination.
   */
  async function jqlV2(
    query: string,
    fields?: string[],
    maxResults: number = 50
  ): Promise<{ issues: Array<{ key: string; fields: Record<string, unknown> }>; total: number }> {
    const pageSize = Math.min(maxResults, 100);
    const allIssues: Array<{ key: string; fields: Record<string, unknown> }> = [];
    let total = 0;
    let nextPageToken: string | undefined;

    while (allIssues.length < maxResults) {
      const queryParams: Record<string, string | undefined> = {
        jql: query,
        fields: fields?.join(','),
        maxResults: String(pageSize),
      };
      if (nextPageToken) {
        queryParams.nextPageToken = nextPageToken;
      }

      const result = (await request({
        method: 'GET',
        path: '/rest/api/3/search/jql',
        query: queryParams,
      })) as {
        issues: Array<{ key: string; fields: Record<string, unknown> }>;
        total: number;
        nextPageToken?: string;
      };

      total = result.total;
      convertAdfFields(result.issues);
      allIssues.push(...result.issues);

      if (!result.nextPageToken || allIssues.length >= total) break;
      nextPageToken = result.nextPageToken;
    }

    return { issues: allIssues.slice(0, maxResults), total };
  }

  /**
   * Auto-paginated JQL search with automatic fallback.
   *
   * Tries /rest/api/3/search first. If the server returns HTTP 410 (Gone),
   * transparently retries with /rest/api/3/search/jql (cursor-based pagination).
   */
  async function jql(
    query: string,
    fields?: string[],
    maxResults: number = 50
  ): Promise<{ issues: Array<{ key: string; fields: Record<string, unknown> }>; total: number }> {
    // Try the legacy endpoint first
    try {
      const response = await rawRequest({
        method: 'GET',
        path: '/rest/api/3/search',
        query: {
          jql: query,
          fields: fields?.join(','),
          startAt: '0',
          maxResults: String(Math.min(maxResults, 100)),
        },
      });

      if (response.status === 410) {
        // Endpoint deprecated — fall through to v2
        return jqlV2(query, fields, maxResults);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Atlassian API error ${response.status}: ${text.slice(0, 500)}`
        );
      }

      // Legacy endpoint works — continue with offset-based pagination
      const firstPage = (await response.json()) as {
        issues: Array<{ key: string; fields: Record<string, unknown> }>;
        total: number;
      };

      const pageSize = Math.min(maxResults, 100);
      let total = firstPage.total;
      convertAdfFields(firstPage.issues);
      const allIssues = [...firstPage.issues];
      let startAt = pageSize;

      while (allIssues.length < maxResults && allIssues.length < total) {
        const result = (await request({
          method: 'GET',
          path: '/rest/api/3/search',
          query: {
            jql: query,
            fields: fields?.join(','),
            startAt: String(startAt),
            maxResults: String(pageSize),
          },
        })) as { issues: Array<{ key: string; fields: Record<string, unknown> }>; total: number };

        total = result.total;
        convertAdfFields(result.issues);
        allIssues.push(...result.issues);
        startAt += pageSize;
      }

      return { issues: allIssues.slice(0, maxResults), total };
    } catch (err) {
      // If the error is from our own 410 handling above, it already fell through.
      // For unexpected network errors on the first request, try v2 as a fallback.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('410')) {
        return jqlV2(query, fields, maxResults);
      }
      throw err;
    }
  }

  async function getIssue(
    key: string,
    fields?: string[]
  ): Promise<unknown> {
    const query: Record<string, string | undefined> = {};
    if (fields) query.fields = fields.join(',');

    const result = (await request({
      method: 'GET',
      path: `/rest/api/3/issue/${encodeURIComponent(key)}`,
      query,
    })) as { fields?: Record<string, unknown> };

    // Auto-convert ADF description
    if (result.fields?.description && typeof result.fields.description === 'object') {
      result.fields.description = adfToText(result.fields.description);
    }

    return result;
  }

  async function getTransitions(
    key: string
  ): Promise<Array<{ id: string; name: string }>> {
    const result = (await request({
      method: 'GET',
      path: `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    })) as { transitions: Array<{ id: string; name: string }> };

    return result.transitions.map((t) => ({ id: t.id, name: t.name }));
  }

  async function transition(
    key: string,
    transitionId: string,
    fields?: unknown
  ): Promise<void> {
    await request({
      method: 'POST',
      path: `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      body: {
        transition: { id: transitionId },
        ...(fields ? { fields } : {}),
      },
    });
  }

  async function addComment(key: string, body: string): Promise<unknown> {
    return request({
      method: 'POST',
      path: `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      body: { body: textToAdf(body) },
    });
  }

  async function createIssue(
    project: string,
    type: string,
    fields: Record<string, unknown>
  ): Promise<{ key: string }> {
    const result = (await request({
      method: 'POST',
      path: '/rest/api/3/issue',
      body: {
        fields: {
          project: { key: project },
          issuetype: { name: type },
          ...fields,
          // Convert description to ADF if it's a string
          ...(typeof fields.description === 'string'
            ? { description: textToAdf(fields.description as string) }
            : {}),
        },
      },
    })) as { key: string };

    return { key: result.key };
  }

  async function updateIssue(
    key: string,
    fields: Record<string, unknown>
  ): Promise<void> {
    await request({
      method: 'PUT',
      path: `/rest/api/3/issue/${encodeURIComponent(key)}`,
      body: {
        fields: {
          ...fields,
          // Convert description to ADF if it's a string
          ...(typeof fields.description === 'string'
            ? { description: textToAdf(fields.description as string) }
            : {}),
        },
      },
    });
  }

  async function linkIssues(
    inwardKey: string,
    outwardKey: string,
    linkType: string
  ): Promise<void> {
    await request({
      method: 'POST',
      path: '/rest/api/3/issueLink',
      body: {
        type: { name: linkType },
        inwardIssue: { key: inwardKey },
        outwardIssue: { key: outwardKey },
      },
    });
  }

  return {
    request: jiraRequest,
    jql,
    jqlV2,
    getIssue,
    getTransitions,
    transition,
    addComment,
    createIssue,
    updateIssue,
    linkIssues,
  };
}
