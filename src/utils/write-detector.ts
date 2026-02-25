/**
 * Detect write operations in LLM-generated code.
 *
 * Uses simple string/regex matching (not full AST analysis).
 * False positives (asking for confirmation when not needed) are acceptable.
 * False negatives (missing a write operation) are not.
 */

const MUTATING_METHOD_PATTERNS = [
  // Jira convenience methods
  /atlassian\.jira\.createIssue\s*\(/,
  /atlassian\.jira\.updateIssue\s*\(/,
  /atlassian\.jira\.transition\s*\(/,
  /atlassian\.jira\.addComment\s*\(/,
  /atlassian\.jira\.linkIssues\s*\(/,

  // Confluence convenience methods
  /atlassian\.confluence\.createPage\s*\(/,
  /atlassian\.confluence\.updatePage\s*\(/,

  // Raw request with mutating HTTP methods
  /\.request\s*\(\s*\{[^}]*method\s*:\s*['"]POST['"]/,
  /\.request\s*\(\s*\{[^}]*method\s*:\s*['"]PUT['"]/,
  /\.request\s*\(\s*\{[^}]*method\s*:\s*['"]DELETE['"]/,
];

export function detectWriteOperations(code: string): boolean {
  return MUTATING_METHOD_PATTERNS.some((pattern) => pattern.test(code));
}

/**
 * Extract a human-readable summary of what write operations the code performs.
 */
export function describeWriteOperations(code: string): string[] {
  const ops: string[] = [];

  if (/atlassian\.jira\.createIssue\s*\(/.test(code)) ops.push('CREATE_ISSUE');
  if (/atlassian\.jira\.updateIssue\s*\(/.test(code)) ops.push('UPDATE_ISSUE');
  if (/atlassian\.jira\.transition\s*\(/.test(code)) ops.push('TRANSITION_ISSUE');
  if (/atlassian\.jira\.addComment\s*\(/.test(code)) ops.push('ADD_COMMENT');
  if (/atlassian\.jira\.linkIssues\s*\(/.test(code)) ops.push('LINK_ISSUES');
  if (/atlassian\.confluence\.createPage\s*\(/.test(code)) ops.push('CREATE_PAGE');
  if (/atlassian\.confluence\.updatePage\s*\(/.test(code)) ops.push('UPDATE_PAGE');

  // Raw requests
  if (/\.request\s*\(\s*\{[^}]*method\s*:\s*['"]POST['"]/.test(code)) ops.push('RAW_POST');
  if (/\.request\s*\(\s*\{[^}]*method\s*:\s*['"]PUT['"]/.test(code)) ops.push('RAW_PUT');
  if (/\.request\s*\(\s*\{[^}]*method\s*:\s*['"]DELETE['"]/.test(code)) ops.push('RAW_DELETE');

  return ops;
}
