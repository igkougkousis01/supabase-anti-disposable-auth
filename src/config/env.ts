/**
 * The single place where environment variables are read and validated.
 *
 * No other module may touch `process.env`: commands receive an {@link AppConfig}
 * instead. That keeps validation in one place and makes it obvious which secrets
 * the tool consumes.
 */

import { existsSync } from 'node:fs';
import { z } from 'zod';

import { ConfigurationError } from '../lib/errors.js';
import type { AppConfig, NodeVersionRequirement } from './types.js';

/** Matches the `engines.node` constraint in package.json. */
export const MINIMUM_NODE_VERSION: NodeVersionRequirement = { major: 20, minor: 12, patch: 0 };

export const MINIMUM_NODE_VERSION_LABEL = `${MINIMUM_NODE_VERSION.major}.${MINIMUM_NODE_VERSION.minor}.${MINIMUM_NODE_VERSION.patch}`;

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

const databaseUrlSchema = z.string().trim().refine(isPostgresConnectionString, {
  message:
    'must be a PostgreSQL connection string, for example postgresql://user:password@host:5432/postgres?sslmode=require',
});

const environmentSchema = z.object({
  SUPABASE_DB_URL: z.preprocess(blankToUndefined, databaseUrlSchema.optional()),
});

/** Environment variables this tool reads. Documented in `.env.example`. */
export const KNOWN_ENVIRONMENT_VARIABLES = ['SUPABASE_DB_URL'] as const;

/**
 * Validates the given environment (defaults to the process environment).
 *
 * @throws ConfigurationError when a variable is present but invalid. The offending
 * value is never included in the message, because it is a credential.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse({ SUPABASE_DB_URL: env['SUPABASE_DB_URL'] });

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'} ${issue.message}`)
      .join('; ');

    throw new ConfigurationError(`Invalid configuration: ${details}`, {
      hint: 'Check your environment variables against .env.example.',
    });
  }

  return { databaseUrl: result.data.SUPABASE_DB_URL };
}

/**
 * Loads a local `.env` file when one exists, using Node's built-in parser.
 *
 * Called once from the CLI entry point. Values already present in the real
 * environment win, which is what `process.loadEnvFile` does by design.
 */
export function loadEnvFileIfPresent(path = '.env'): void {
  if (!existsSync(path)) {
    return;
  }

  try {
    process.loadEnvFile(path);
  } catch (cause) {
    throw new ConfigurationError(`Could not read ${path}`, {
      cause,
      hint: 'Fix or remove the file, or export the variables in your shell instead.',
    });
  }
}

/** True when the running Node.js version satisfies {@link MINIMUM_NODE_VERSION}. */
export function isSupportedNodeVersion(version: string): boolean {
  const parsed = parseNodeVersion(version);
  if (parsed === undefined) {
    return false;
  }

  if (parsed.major !== MINIMUM_NODE_VERSION.major) {
    return parsed.major > MINIMUM_NODE_VERSION.major;
  }
  if (parsed.minor !== MINIMUM_NODE_VERSION.minor) {
    return parsed.minor > MINIMUM_NODE_VERSION.minor;
  }
  return parsed.patch >= MINIMUM_NODE_VERSION.patch;
}

function parseNodeVersion(version: string): NodeVersionRequirement | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) {
    return undefined;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isPostgresConnectionString(value: string): boolean {
  try {
    const url = new URL(value);
    return POSTGRES_PROTOCOLS.has(url.protocol) && url.hostname !== '';
  } catch {
    return false;
  }
}

function blankToUndefined(value: unknown): unknown {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
}
