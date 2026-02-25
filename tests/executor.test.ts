import { describe, it, expect, vi } from 'vitest';
import {
  IsolatedVMExecutor,
  NodeVMExecutor,
  SearchExecutor,
} from '../src/sandbox/executor.js';

// Test both executors with the same test suite
const executors = [
  { name: 'IsolatedVMExecutor', create: async () => { const e = new IsolatedVMExecutor(); await e.init(); return e; } },
  { name: 'NodeVMExecutor', create: async () => new NodeVMExecutor() },
];

for (const { name, create } of executors) {
  describe(name, () => {
    it('should execute simple code that returns a value', async () => {
      const executor = await create();
      const result = await executor.execute('async () => 42', {});
      expect(result.result).toBe(42);
      expect(result.error).toBeUndefined();
    });

    it('should execute code that returns an object', async () => {
      const executor = await create();
      const result = await executor.execute(
        'async () => ({ name: "test", count: 3 })',
        {}
      );
      expect(result.result).toEqual({ name: 'test', count: 3 });
    });

    it('should call tool functions via atlassian proxy', async () => {
      const executor = await create();
      const mockJql = vi.fn(async (args: unknown) => ({
        issues: [{ key: 'TEST-1', fields: { summary: 'Test issue' } }],
        total: 1,
      }));

      const result = await executor.execute(
        `async () => {
          const r = await atlassian.jira.jql('project = TEST');
          return r;
        }`,
        { 'jira.jql': mockJql }
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        issues: [{ key: 'TEST-1', fields: { summary: 'Test issue' } }],
        total: 1,
      });
      expect(mockJql).toHaveBeenCalled();
    });

    it('should handle multiple sequential tool calls', async () => {
      const executor = await create();
      const mockGetIssue = vi.fn(async () => ({
        key: 'TEST-1',
        fields: { summary: 'Issue 1' },
      }));
      const mockGetTransitions = vi.fn(async () => [
        { id: '31', name: 'Done' },
      ]);

      const result = await executor.execute(
        `async () => {
          const issue = await atlassian.jira.getIssue('TEST-1');
          const transitions = await atlassian.jira.getTransitions('TEST-1');
          return { issue: issue.key, transitions };
        }`,
        {
          'jira.getIssue': mockGetIssue,
          'jira.getTransitions': mockGetTransitions,
        }
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        issue: 'TEST-1',
        transitions: [{ id: '31', name: 'Done' }],
      });
    });

    it('should capture console.log output', async () => {
      const executor = await create();
      const result = await executor.execute(
        `async () => {
          console.log('hello');
          console.warn('careful');
          return 'done';
        }`,
        {}
      );

      expect(result.result).toBe('done');
      expect(result.logs).toContain('hello');
      expect(result.logs?.some((l) => l.includes('careful'))).toBe(true);
    });

    it('should return error when code throws', async () => {
      const executor = await create();
      const result = await executor.execute(
        'async () => { throw new Error("boom"); }',
        {}
      );
      expect(result.error).toContain('boom');
    });

    it('should return error when tool function throws', async () => {
      const executor = await create();
      const result = await executor.execute(
        `async () => await atlassian.jira.jql('bad query')`,
        {
          'jira.jql': async () => {
            throw new Error('JQL syntax error');
          },
        }
      );
      expect(result.error).toContain('JQL syntax error');
    });

    it('should handle empty code gracefully', async () => {
      const executor = await create();
      const result = await executor.execute('', {});
      expect(result.error).toBeUndefined();
    });
  });
}

describe('SearchExecutor', () => {
  const specData = {
    jira: {
      paths: {
        '/rest/api/3/issue': {
          get: { summary: 'Get issue', tags: ['Issues'] },
          post: { summary: 'Create issue', tags: ['Issues'] },
        },
        '/rest/api/3/search': {
          get: { summary: 'Search issues', tags: ['Search'] },
        },
      },
      endpointCount: 3,
    },
    confluence: {
      paths: {
        '/wiki/rest/api/content': {
          get: { summary: 'Get content', tags: ['Content'] },
        },
      },
      endpointCount: 1,
    },
  };

  it('should allow querying the spec object', async () => {
    const executor = new SearchExecutor(specData);
    const result = await executor.execute(
      `async () => {
        const paths = Object.keys(spec.jira.paths);
        return paths;
      }`,
      {}
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual([
      '/rest/api/3/issue',
      '/rest/api/3/search',
    ]);
  });

  it('should allow filtering endpoints by tag', async () => {
    const executor = new SearchExecutor(specData);
    const result = await executor.execute(
      `async () => {
        const results = [];
        for (const [path, methods] of Object.entries(spec.jira.paths)) {
          for (const [method, op] of Object.entries(methods)) {
            if (typeof op === 'object' && op.tags && op.tags.includes('Search')) {
              results.push({ method: method.toUpperCase(), path, summary: op.summary });
            }
          }
        }
        return results;
      }`,
      {}
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual([
      { method: 'GET', path: '/rest/api/3/search', summary: 'Search issues' },
    ]);
  });

  it('should allow querying confluence spec', async () => {
    const executor = new SearchExecutor(specData);
    const result = await executor.execute(
      `async () => Object.keys(spec.confluence.paths)`,
      {}
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual(['/wiki/rest/api/content']);
  });

  it('should have no network access (no atlassian proxy)', async () => {
    const executor = new SearchExecutor(specData);
    const result = await executor.execute(
      `async () => typeof atlassian`,
      {}
    );
    // atlassian should not be defined in search context
    expect(result.result).toBe('undefined');
  });
});
