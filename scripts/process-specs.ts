/**
 * Build-time script to download and process Atlassian OpenAPI specs.
 *
 * Usage: npx tsx scripts/process-specs.ts
 *
 * Downloads the Jira and Confluence OpenAPI specs, resolves all $refs,
 * strips non-essential metadata, and writes processed JSON to data/.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processSpec, stripMetadata } from '../src/spec/processor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

const SPECS = [
  {
    name: 'jira',
    url: 'https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json',
    output: 'jira-spec.json',
  },
  {
    name: 'confluence',
    url: 'https://developer.atlassian.com/cloud/confluence/swagger.v3.json',
    output: 'confluence-spec.json',
  },
];

async function main() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  for (const spec of SPECS) {
    console.log(`Downloading ${spec.name} spec from ${spec.url}...`);
    const response = await fetch(spec.url);
    if (!response.ok) {
      console.error(`Failed to download ${spec.name} spec: ${response.status}`);
      continue;
    }

    const rawSpec = (await response.json()) as Record<string, unknown>;
    console.log(`Processing ${spec.name} spec (resolving $refs, stripping metadata)...`);

    const processed = processSpec(rawSpec);
    const stripped = stripMetadata(processed) as typeof processed;

    const json = JSON.stringify(stripped);
    const outputPath = join(DATA_DIR, spec.output);
    writeFileSync(outputPath, json);

    const sizeMb = (json.length / 1024 / 1024).toFixed(2);
    console.log(
      `Wrote ${spec.name} spec: ${stripped.endpointCount} endpoints, ${sizeMb} MB → ${outputPath}`
    );
  }

  console.log('Done!');
}

main().catch(console.error);
