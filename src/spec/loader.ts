/**
 * Spec loader — loads pre-processed OpenAPI specs from embedded JSON files.
 *
 * At build time, specs are processed and written to data/.
 * At runtime, this loader reads them into memory.
 *
 * If no pre-processed specs exist, returns empty specs
 * (the search tool will still work but return no results).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');

interface ProcessedSpec {
  paths: Record<string, Record<string, unknown>>;
  endpointCount: number;
}

export interface SpecData {
  jira: ProcessedSpec;
  confluence: ProcessedSpec;
}

export function loadSpecs(): SpecData {
  const jiraPath = join(DATA_DIR, 'jira-spec.json');
  const confluencePath = join(DATA_DIR, 'confluence-spec.json');

  const emptySpec: ProcessedSpec = { paths: {}, endpointCount: 0 };

  let jira: ProcessedSpec = emptySpec;
  let confluence: ProcessedSpec = emptySpec;

  if (existsSync(jiraPath)) {
    try {
      jira = JSON.parse(readFileSync(jiraPath, 'utf-8'));
      console.error(`[atlassian-codemode] Loaded Jira spec: ${jira.endpointCount} endpoints`);
    } catch (err) {
      console.error(`[atlassian-codemode] Failed to load Jira spec: ${err}`);
    }
  } else {
    console.error('[atlassian-codemode] No Jira spec found. Run: npm run process-specs');
  }

  if (existsSync(confluencePath)) {
    try {
      confluence = JSON.parse(readFileSync(confluencePath, 'utf-8'));
      console.error(`[atlassian-codemode] Loaded Confluence spec: ${confluence.endpointCount} endpoints`);
    } catch (err) {
      console.error(`[atlassian-codemode] Failed to load Confluence spec: ${err}`);
    }
  } else {
    console.error('[atlassian-codemode] No Confluence spec found. Run: npm run process-specs');
  }

  return { jira, confluence };
}
