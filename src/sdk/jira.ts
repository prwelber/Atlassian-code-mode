/**
 * Jira convenience methods.
 *
 * These wrap the raw request function with Jira-specific logic:
 * field selection, auto-pagination, ADF conversion, etc.
 */

import type { AtlassianConfig, AtlassianRequestOptions } from '../types.js';
import { createRequestFn } from './request.js';
import { adfToText, textToAdf } from '../utils/adf.js';

export function createJiraSdk(config: AtlassianConfig) {
  const request = createRequestFn(config);

  async function jiraRequest(opts: AtlassianRequestOptions): Promise<unknown> {
    return request(opts);
  }

  async function jql(
    query: string,
    fields?: string[],
    maxResults: number = 50
  ): Promise<{ issues: Array<{ key: string; fields: Record<string, unknown> }>; total: number }> {
    const pageSize = Math.min(maxResults, 100);
    let startAt = 0;
    const allIssues: Array<{ key: string; fields: Record<string, unknown> }> = [];
    let total = 0;

    while (allIssues.length < maxResults) {
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

      // Auto-convert ADF descriptions to plain text
      for (const issue of result.issues) {
        if (
          issue.fields?.description &&
          typeof issue.fields.description === 'object'
        ) {
          issue.fields.description = adfToText(issue.fields.description);
        }
        // Also convert comments if present
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

      allIssues.push(...result.issues);
      if (allIssues.length >= total) break;
      startAt += pageSize;
    }

    return { issues: allIssues.slice(0, maxResults), total };
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
    getIssue,
    getTransitions,
    transition,
    addComment,
    createIssue,
    updateIssue,
    linkIssues,
  };
}
