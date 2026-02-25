/**
 * Output truncation for MCP tool responses.
 *
 * Follows Cloudflare's production pattern: simple character-based
 * truncation with an actionable message telling the model to refine
 * its query.
 */

const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 6000;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN; // 24,000 chars

export function truncateResponse(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : JSON.stringify(content, null, 2);

  if (text.length <= MAX_CHARS) {
    return text;
  }

  const truncated = text.slice(0, MAX_CHARS);
  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN);

  return `${truncated}\n\n--- TRUNCATED ---\nResponse was ~${estimatedTokens.toLocaleString()} tokens (limit: ${MAX_TOKENS.toLocaleString()}). Refine your code to return less data (select fewer fields, reduce maxResults, or filter in code).`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
