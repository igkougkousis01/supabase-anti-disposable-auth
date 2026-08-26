/** Loads the deterministic blocklist fixtures. No network, no database. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'blocklists',
);

export function readBlocklistFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIRECTORY, name), 'utf8');
}

/** The canonical domain set every "same data" fixture reduces to. */
export const FIXTURE_DOMAINS = [
  '10minutemail.com',
  'guerrillamail.com',
  'mailinator.com',
  'trashmail.example',
  'yopmail.com',
];

/** Builds a synthetic list large enough to clear the default safety thresholds. */
export function generateDomainList(count: number, prefix = 'domain'): string[] {
  return Array.from({ length: count }, (_value, index) => `${prefix}${index}.example`);
}
