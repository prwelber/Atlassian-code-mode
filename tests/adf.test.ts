import { describe, it, expect } from 'vitest';
import { adfToText, textToAdf } from '../src/utils/adf.js';

describe('adfToText', () => {
  it('should return empty string for null/undefined', () => {
    expect(adfToText(null)).toBe('');
    expect(adfToText(undefined)).toBe('');
  });

  it('should convert simple paragraph', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      ],
    };
    expect(adfToText(adf)).toBe('Hello world');
  });

  it('should convert headings', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'My Heading' }],
        },
      ],
    };
    expect(adfToText(adf)).toBe('## My Heading');
  });

  it('should convert text marks (bold, italic, code, link)', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'italic', marks: [{ type: 'em' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'code', marks: [{ type: 'code' }] },
            { type: 'text', text: ' ' },
            {
              type: 'text',
              text: 'link',
              marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
            },
          ],
        },
      ],
    };
    const result = adfToText(adf);
    expect(result).toContain('**bold**');
    expect(result).toContain('*italic*');
    expect(result).toContain('`code`');
    expect(result).toContain('[link](https://example.com)');
  });

  it('should convert bullet lists', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Item 1' }],
                },
              ],
            },
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Item 2' }],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = adfToText(adf);
    expect(result).toContain('- Item 1');
    expect(result).toContain('- Item 2');
  });

  it('should convert code blocks', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'javascript' },
          content: [{ type: 'text', text: 'const x = 1;' }],
        },
      ],
    };
    const result = adfToText(adf);
    expect(result).toContain('```javascript');
    expect(result).toContain('const x = 1;');
    expect(result).toContain('```');
  });

  it('should convert mentions', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { text: 'Jane Doe' } },
          ],
        },
      ],
    };
    expect(adfToText(adf)).toContain('@Jane Doe');
  });

  it('should handle tables', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Name' }],
                    },
                  ],
                },
                {
                  type: 'tableHeader',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Value' }],
                    },
                  ],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Foo' }],
                    },
                  ],
                },
                {
                  type: 'tableCell',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Bar' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = adfToText(adf);
    expect(result).toContain('Name');
    expect(result).toContain('Value');
    expect(result).toContain('Foo');
    expect(result).toContain('Bar');
    expect(result).toContain('|');
  });

  it('should handle unsupported node types gracefully', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'unknownType' },
      ],
    };
    expect(adfToText(adf)).toContain('[unsupported: unknownType]');
  });
});

describe('textToAdf', () => {
  it('should create valid ADF from plain text', () => {
    const adf = textToAdf('Hello world') as { type: string; content: unknown[] };
    expect(adf.type).toBe('doc');
    expect(adf.content).toHaveLength(1);
  });

  it('should split paragraphs on double newlines', () => {
    const adf = textToAdf('Para 1\n\nPara 2') as { content: unknown[] };
    expect(adf.content).toHaveLength(2);
  });
});
