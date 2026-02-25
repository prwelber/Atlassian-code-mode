import { describe, it, expect } from 'vitest';
import {
  detectWriteOperations,
  describeWriteOperations,
} from '../src/utils/write-detector.js';

describe('detectWriteOperations', () => {
  it('should detect Jira create operations', () => {
    expect(
      detectWriteOperations(
        'await atlassian.jira.createIssue("PROJ", "Bug", { summary: "test" })'
      )
    ).toBe(true);
  });

  it('should detect Jira update operations', () => {
    expect(
      detectWriteOperations(
        'await atlassian.jira.updateIssue("PROJ-123", { summary: "test" })'
      )
    ).toBe(true);
  });

  it('should detect transitions', () => {
    expect(
      detectWriteOperations('await atlassian.jira.transition("PROJ-123", "31")')
    ).toBe(true);
  });

  it('should detect comments', () => {
    expect(
      detectWriteOperations(
        'await atlassian.jira.addComment("PROJ-123", "hello")'
      )
    ).toBe(true);
  });

  it('should detect Confluence writes', () => {
    expect(
      detectWriteOperations(
        'await atlassian.confluence.createPage("SPACE", "Title", "Body")'
      )
    ).toBe(true);
  });

  it('should detect raw POST requests', () => {
    expect(
      detectWriteOperations(
        'await atlassian.jira.request({ method: \'POST\', path: "/rest/api/3/issue" })'
      )
    ).toBe(true);
  });

  it('should detect raw DELETE requests', () => {
    expect(
      detectWriteOperations(
        'await atlassian.jira.request({ method: "DELETE", path: "/rest/api/3/issue/PROJ-1" })'
      )
    ).toBe(true);
  });

  it('should not detect read operations', () => {
    expect(
      detectWriteOperations(
        'await atlassian.jira.jql("project = PROJ", ["summary"])'
      )
    ).toBe(false);
  });

  it('should not detect GET requests', () => {
    expect(
      detectWriteOperations(
        'await atlassian.jira.request({ method: "GET", path: "/rest/api/3/issue/PROJ-1" })'
      )
    ).toBe(false);
  });

  it('should not detect getIssue', () => {
    expect(
      detectWriteOperations('await atlassian.jira.getIssue("PROJ-123")')
    ).toBe(false);
  });
});

describe('describeWriteOperations', () => {
  it('should list all detected operations', () => {
    const code = `
      await atlassian.jira.createIssue("PROJ", "Bug", {});
      await atlassian.jira.addComment("PROJ-1", "test");
    `;
    const ops = describeWriteOperations(code);
    expect(ops).toContain('CREATE_ISSUE');
    expect(ops).toContain('ADD_COMMENT');
  });
});
