import { describe, it, expect } from 'vitest';
import { truncateResponse, estimateTokens } from '../src/utils/truncate.js';

describe('truncateResponse', () => {
  it('should return short strings unchanged', () => {
    expect(truncateResponse('hello')).toBe('hello');
  });

  it('should JSON-stringify objects', () => {
    const result = truncateResponse({ key: 'value' });
    expect(result).toContain('"key"');
    expect(result).toContain('"value"');
  });

  it('should truncate strings exceeding 24K chars', () => {
    const longString = 'x'.repeat(30000);
    const result = truncateResponse(longString);
    expect(result).toContain('--- TRUNCATED ---');
    expect(result).toContain('reduce size');
    expect(result.length).toBeLessThan(longString.length);
  });

  it('should not truncate strings at exactly the limit', () => {
    const exactString = 'x'.repeat(24000);
    const result = truncateResponse(exactString);
    expect(result).not.toContain('TRUNCATED');
  });

  it('should include estimated token count in truncation message', () => {
    const longString = 'x'.repeat(30000);
    const result = truncateResponse(longString);
    expect(result).toContain('7,500'); // 30000 / 4
  });
});

describe('estimateTokens', () => {
  it('should estimate 1 token per 4 chars', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('should round up', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});
