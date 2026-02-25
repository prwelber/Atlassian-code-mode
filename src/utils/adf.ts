/**
 * ADF (Atlassian Document Format) → plain text converter.
 *
 * ADF is a deeply nested JSON format for rich text. A 500-word page
 * can be 20KB in ADF vs 3KB in plain text.
 *
 * Covers the top node types (~95% of real content):
 * paragraph, heading, text with marks, bulletList, orderedList,
 * codeBlock, blockquote, table, mention, emoji, hardBreak
 */

interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

export function adfToText(adf: unknown): string {
  if (!adf || typeof adf !== 'object') return '';
  const doc = adf as AdfNode;
  if (!doc.content) return doc.text || '';
  return doc.content.map((node) => renderNode(node)).join('\n\n');
}

function renderNode(node: AdfNode): string {
  switch (node.type) {
    case 'paragraph':
      return renderInline(node.content);

    case 'heading': {
      const level = (node.attrs?.level as number) || 1;
      return '#'.repeat(level) + ' ' + renderInline(node.content);
    }

    case 'bulletList':
      return (node.content || [])
        .map((li) => '- ' + renderListItem(li))
        .join('\n');

    case 'orderedList':
      return (node.content || [])
        .map((li, i) => `${i + 1}. ` + renderListItem(li))
        .join('\n');

    case 'listItem':
      return renderListItem(node);

    case 'codeBlock': {
      const lang = (node.attrs?.language as string) || '';
      return '```' + lang + '\n' + renderInline(node.content) + '\n```';
    }

    case 'blockquote':
      return (node.content || [])
        .map((n) => '> ' + renderNode(n))
        .join('\n');

    case 'table':
      return renderTable(node);

    case 'rule':
      return '---';

    case 'panel': {
      const panelType = (node.attrs?.panelType as string) || 'info';
      const body = (node.content || []).map(renderNode).join('\n');
      return `[${panelType.toUpperCase()}]\n${body}`;
    }

    case 'expand': {
      const title = (node.attrs?.title as string) || 'Details';
      const body = (node.content || []).map(renderNode).join('\n');
      return `<${title}>\n${body}`;
    }

    case 'mediaSingle':
    case 'mediaGroup':
      return '[media]';

    default:
      // Try to render content if present, otherwise fallback
      if (node.content) {
        return node.content.map(renderNode).join('');
      }
      return node.text || `[unsupported: ${node.type}]`;
  }
}

function renderListItem(node: AdfNode): string {
  if (!node.content) return '';
  return node.content.map(renderNode).join('\n  ');
}

function renderInline(content?: AdfNode[]): string {
  if (!content) return '';
  return content.map(renderInlineNode).join('');
}

function renderInlineNode(node: AdfNode): string {
  if (node.type === 'text') {
    let text = node.text || '';
    if (node.marks) {
      for (const mark of node.marks) {
        switch (mark.type) {
          case 'strong':
            text = `**${text}**`;
            break;
          case 'em':
            text = `*${text}*`;
            break;
          case 'code':
            text = `\`${text}\``;
            break;
          case 'strike':
            text = `~~${text}~~`;
            break;
          case 'link': {
            const href = mark.attrs?.href as string;
            if (href) text = `[${text}](${href})`;
            break;
          }
          // textColor, subsup, underline — just render text as-is
        }
      }
    }
    return text;
  }

  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') {
    return `@${(node.attrs?.text as string) || 'unknown'}`;
  }
  if (node.type === 'emoji') {
    return (node.attrs?.shortName as string) || ':emoji:';
  }
  if (node.type === 'inlineCard') {
    return (node.attrs?.url as string) || '[card]';
  }
  if (node.type === 'status') {
    return `[${(node.attrs?.text as string) || 'status'}]`;
  }
  if (node.type === 'date') {
    return (node.attrs?.timestamp as string) || '[date]';
  }

  // Fallback for unknown inline nodes
  if (node.content) return renderInline(node.content);
  return node.text || '';
}

function renderTable(node: AdfNode): string {
  if (!node.content) return '';

  const rows = node.content.map((row) => {
    if (!row.content) return [];
    return row.content.map((cell) => {
      const cellContent = (cell.content || []).map(renderNode).join(' ');
      return cellContent.replace(/\n/g, ' ').trim();
    });
  });

  if (rows.length === 0) return '';

  // Calculate column widths
  const colCount = Math.max(...rows.map((r) => r.length));
  const colWidths: number[] = Array(colCount).fill(3);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      colWidths[i] = Math.max(colWidths[i], row[i].length);
    }
  }

  const formatRow = (cells: string[]) =>
    '| ' +
    cells
      .map((cell, i) => cell.padEnd(colWidths[i] || 3))
      .join(' | ') +
    ' |';

  const separator =
    '| ' + colWidths.map((w) => '-'.repeat(w)).join(' | ') + ' |';

  const lines = [formatRow(rows[0])];
  lines.push(separator);
  for (let i = 1; i < rows.length; i++) {
    lines.push(formatRow(rows[i]));
  }

  return lines.join('\n');
}

/**
 * Convert plain text to minimal ADF for creating/updating content.
 * Handles basic paragraphs and newline-delimited text.
 */
export function textToAdf(text: string): object {
  const paragraphs = text.split(/\n\n+/).map((para) => ({
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: para.trim(),
      },
    ],
  }));

  return {
    version: 1,
    type: 'doc',
    content: paragraphs,
  };
}
