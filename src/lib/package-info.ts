/**
 * Package metadata resolved at runtime.
 *
 * The version is read from the nearest package.json so it stays correct both when
 * running from source (`tsx src/cli.ts`) and from the bundle (`dist/cli.js`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI_NAME = 'supabase-anti-disposable-auth';
export const PRODUCT_NAME = 'Supabase Anti-Disposable Auth';
export const PRODUCT_DESCRIPTION =
  'Install database-level disposable-email protection into Supabase projects.';

const UNKNOWN_VERSION = '0.0.0-unknown';

let cachedVersion: string | undefined;

export function getPackageVersion(): string {
  cachedVersion ??= readVersion();
  return cachedVersion;
}

/**
 * Absolute path of the installed package root, i.e. the directory holding package.json.
 *
 * Used to locate files that ship alongside the code but are not bundled into `dist/`,
 * such as `migrations/`. Walking up from this module works both when running from
 * source (`src/lib/`) and from the bundle (`dist/`).
 *
 * Returns `undefined` if no package.json is found, which callers must report rather
 * than paper over.
 */
export function getPackageRoot(): string | undefined {
  const packageJsonPath = findPackageJson(dirname(fileURLToPath(import.meta.url)));
  return packageJsonPath === undefined ? undefined : dirname(packageJsonPath);
}

function readVersion(): string {
  const packageJsonPath = findPackageJson(dirname(fileURLToPath(import.meta.url)));
  if (packageJsonPath === undefined) {
    return UNKNOWN_VERSION;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const { version } = parsed as { version?: unknown };
      if (typeof version === 'string' && version !== '') {
        return version;
      }
    }
  } catch {
    // A missing or unreadable package.json must not break `--help`.
  }

  return UNKNOWN_VERSION;
}

function findPackageJson(startDirectory: string): string | undefined {
  let directory = startDirectory;

  for (;;) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}
