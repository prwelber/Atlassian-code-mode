import { describe, it, expect } from 'vitest';
import { resolveRefs, processSpec, stripMetadata } from '../src/spec/processor.js';

describe('resolveRefs', () => {
  it('should resolve simple $ref', () => {
    const spec = {
      definitions: {
        User: { type: 'object', properties: { name: { type: 'string' } } },
      },
    };
    const ref = { $ref: '#/definitions/User' };
    const result = resolveRefs(ref, spec);
    expect(result).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
    });
  });

  it('should handle circular $refs', () => {
    const spec = {
      definitions: {
        Node: {
          type: 'object',
          properties: {
            child: { $ref: '#/definitions/Node' },
          },
        },
      },
    };
    const result = resolveRefs(
      { $ref: '#/definitions/Node' },
      spec
    ) as Record<string, unknown>;
    expect(result.type).toBe('object');
    const props = result.properties as Record<string, unknown>;
    expect(props.child).toEqual({ $circular: '#/definitions/Node' });
  });

  it('should handle missing $refs', () => {
    const result = resolveRefs({ $ref: '#/missing/path' }, {});
    expect(result).toEqual({ $unresolved: '#/missing/path' });
  });

  it('should resolve nested $refs', () => {
    const spec = {
      definitions: {
        Name: { type: 'string' },
        User: {
          type: 'object',
          properties: { name: { $ref: '#/definitions/Name' } },
        },
      },
    };
    const result = resolveRefs(
      { $ref: '#/definitions/User' },
      spec
    ) as Record<string, unknown>;
    const props = result.properties as Record<string, unknown>;
    expect(props.name).toEqual({ type: 'string' });
  });

  it('should handle arrays', () => {
    const spec = {
      definitions: { Item: { type: 'string' } },
    };
    const result = resolveRefs(
      [{ $ref: '#/definitions/Item' }, 'plain'],
      spec
    );
    expect(result).toEqual([{ type: 'string' }, 'plain']);
  });
});

describe('processSpec', () => {
  it('should extract operations from paths', () => {
    const spec = {
      paths: {
        '/rest/api/3/issue': {
          get: {
            summary: 'Get issues',
            tags: ['Issues'],
          },
          post: {
            summary: 'Create issue',
            tags: ['Issues'],
          },
        },
      },
    };
    const result = processSpec(spec as Record<string, unknown>);
    expect(result.endpointCount).toBe(2);
    expect(result.paths['/rest/api/3/issue']).toBeDefined();
    expect(result.paths['/rest/api/3/issue'].get).toBeDefined();
    expect(result.paths['/rest/api/3/issue'].post).toBeDefined();
  });

  it('should skip deprecated endpoints', () => {
    const spec = {
      paths: {
        '/old': {
          get: { summary: 'Old endpoint', deprecated: true },
        },
        '/new': {
          get: { summary: 'New endpoint' },
        },
      },
    };
    const result = processSpec(spec as Record<string, unknown>);
    expect(result.endpointCount).toBe(1);
    expect(result.paths['/old']).toBeUndefined();
    expect(result.paths['/new']).toBeDefined();
  });
});

describe('stripMetadata', () => {
  it('should remove x-atlassian-* keys', () => {
    const result = stripMetadata({
      summary: 'Test',
      'x-atlassian-oauth2-scopes': ['read'],
      'x-atlassian-connect-scope': 'READ',
    }) as Record<string, unknown>;
    expect(result.summary).toBe('Test');
    expect(result['x-atlassian-oauth2-scopes']).toBeUndefined();
    expect(result['x-atlassian-connect-scope']).toBeUndefined();
  });

  it('should strip deeply nested metadata', () => {
    const result = stripMetadata({
      nested: {
        'x-experimental': true,
        value: 42,
      },
    }) as { nested: Record<string, unknown> };
    expect(result.nested.value).toBe(42);
    expect(result.nested['x-experimental']).toBeUndefined();
  });
});
