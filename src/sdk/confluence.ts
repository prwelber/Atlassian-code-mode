/**
 * Confluence convenience methods.
 *
 * Wraps raw requests with Confluence-specific logic:
 * ADF → plain text conversion, CQL search, pagination, etc.
 */

import type { AtlassianConfig, AtlassianRequestOptions } from '../types.js';
import { createRequestFn } from './request.js';
import { adfToText, textToAdf } from '../utils/adf.js';

export function createConfluenceSdk(config: AtlassianConfig) {
  const request = createRequestFn(config);

  async function confluenceRequest(
    opts: AtlassianRequestOptions
  ): Promise<unknown> {
    return request(opts);
  }

  async function cql(
    query: string,
    maxResults: number = 25
  ): Promise<{
    results: Array<{ id: string; title: string; type: string }>;
  }> {
    const result = (await request({
      method: 'GET',
      path: '/wiki/rest/api/content/search',
      query: {
        cql: query,
        limit: String(Math.min(maxResults, 100)),
      },
    })) as {
      results: Array<{
        id: string;
        title: string;
        type: string;
        [key: string]: unknown;
      }>;
    };

    return {
      results: result.results.map((r) => ({
        id: r.id,
        title: r.title,
        type: r.type,
      })),
    };
  }

  async function getPageText(
    pageId: string
  ): Promise<{ title: string; body: string }> {
    const result = (await request({
      method: 'GET',
      path: `/wiki/rest/api/content/${encodeURIComponent(pageId)}`,
      query: {
        expand: 'body.atlas_doc_format',
      },
    })) as {
      title: string;
      body?: {
        atlas_doc_format?: { value: string };
      };
    };

    let body = '';
    if (result.body?.atlas_doc_format?.value) {
      try {
        const adf = JSON.parse(result.body.atlas_doc_format.value);
        body = adfToText(adf);
      } catch {
        body = result.body.atlas_doc_format.value;
      }
    }

    return { title: result.title, body };
  }

  async function getPageById(pageId: string): Promise<unknown> {
    return request({
      method: 'GET',
      path: `/wiki/rest/api/content/${encodeURIComponent(pageId)}`,
      query: {
        expand: 'body.atlas_doc_format,version,ancestors,space',
      },
    });
  }

  async function createPage(
    spaceKey: string,
    title: string,
    body: string
  ): Promise<{ id: string; title: string }> {
    const result = (await request({
      method: 'POST',
      path: '/wiki/rest/api/content',
      body: {
        type: 'page',
        title,
        space: { key: spaceKey },
        body: {
          atlas_doc_format: {
            value: JSON.stringify(textToAdf(body)),
            representation: 'atlas_doc_format',
          },
        },
      },
    })) as { id: string; title: string };

    return { id: result.id, title: result.title };
  }

  async function updatePage(
    pageId: string,
    title: string,
    body: string
  ): Promise<void> {
    // Need current version number for update
    const current = (await request({
      method: 'GET',
      path: `/wiki/rest/api/content/${encodeURIComponent(pageId)}`,
      query: { expand: 'version' },
    })) as { version: { number: number } };

    await request({
      method: 'PUT',
      path: `/wiki/rest/api/content/${encodeURIComponent(pageId)}`,
      body: {
        type: 'page',
        title,
        version: { number: current.version.number + 1 },
        body: {
          atlas_doc_format: {
            value: JSON.stringify(textToAdf(body)),
            representation: 'atlas_doc_format',
          },
        },
      },
    });
  }

  async function getSpaces(): Promise<
    Array<{ key: string; name: string }>
  > {
    const result = (await request({
      method: 'GET',
      path: '/wiki/rest/api/space',
      query: { limit: '100' },
    })) as { results: Array<{ key: string; name: string }> };

    return result.results.map((s) => ({ key: s.key, name: s.name }));
  }

  async function searchInSpace(
    spaceKey: string,
    query: string
  ): Promise<{
    results: Array<{ id: string; title: string; type: string }>;
  }> {
    return cql(`space = "${spaceKey}" AND (title ~ "${query}" OR text ~ "${query}")`, 25);
  }

  return {
    request: confluenceRequest,
    cql,
    getPageText,
    getPageById,
    createPage,
    updatePage,
    getSpaces,
    searchInSpace,
  };
}
