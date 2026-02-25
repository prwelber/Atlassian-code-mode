import { describe, it, expect } from 'vitest';
import { normalizeCode } from '../src/utils/normalize-code.js';

describe('normalizeCode', () => {
  it('should pass arrow functions through unchanged', () => {
    expect(normalizeCode('async () => { return 42; }')).toBe(
      'async () => { return 42; }'
    );
  });

  it('should pass concise arrow functions through', () => {
    expect(normalizeCode('async () => 42')).toBe('async () => 42');
  });

  it('should wrap bare expressions in async arrow with return', () => {
    const result = normalizeCode('1 + 2');
    expect(result).toContain('async () => {');
    expect(result).toContain('return (1 + 2)');
  });

  it('should wrap multi-statement code with return on last expression', () => {
    const code = `const x = 1;\nconst y = 2;\nx + y`;
    const result = normalizeCode(code);
    expect(result).toContain('async () => {');
    expect(result).toContain('return (x + y)');
  });

  it('should not prepend return to declarations on last line', () => {
    const code = `const x = 1;\nconst y = 2;`;
    const result = normalizeCode(code);
    expect(result).toContain('async () => {');
    expect(result).not.toContain('return const');
  });

  it('should return empty async arrow for empty input', () => {
    expect(normalizeCode('')).toBe('async () => {}');
    expect(normalizeCode('   ')).toBe('async () => {}');
  });

  it('should handle syntax errors by wrapping', () => {
    const code = 'this is not valid @#$';
    const result = normalizeCode(code);
    expect(result).toContain('async () => {');
    expect(result).toContain(code);
  });

  it('should handle parenthesized arrow functions', () => {
    const code = '(async () => { return 42; })';
    const result = normalizeCode(code);
    // Parenthesized arrow is still an ArrowFunctionExpression
    expect(result).toBe(code);
  });
});
