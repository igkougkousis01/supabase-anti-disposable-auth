/**
 * The single place where environment variables are read and validated.
 *
 * No other module may touch `process.env`: commands receive an {@link AppConfig}
 * instead. That keeps validation in one place and makes it obvious which secrets
 * the tool consumes.
 *
 * Every variable here is **optional at load time**, and that is a deliberate design
 * choice rather than laziness. Different commands need different things: `sync` needs a
 * database, `hook enable` needs Management API credentials, and `status` degrades
 * gracefully when the latter are absent. Requiring everything up front would make a
 * database-only workflow fail because a token it never uses is unset. Presence is
 * therefore asserted per command, by {@link requireDatabaseUrl} and
 * {@link requireManagementCredentials}.
 */

import { existsSync } from 'node:fs';
import { z } from 'zod';

import { ConfigurationError } from '../lib/errors.js';
import { CLI_NAME } from '../lib/package-info.js';
import { PROJECT_REF_LENGTH, PROJECT_REF_PATTERN } from '../supabase/constants.js';
import type { AppConfig, ManagementCredentials, NodeVersionRequirement } from './types.js';

/**
 * Matches the `engines.node` constraint in package.json.
 *
 * 22.0.0 is a support decision, not an API constraint: the implementation happens to
 * run on 20.12 and newer, because `process.loadEnvFile` landed in 20.12.0. But Node 20
 * reached end of life in April 2026, and a stable release must not write an unsupported
 * runtime into its compatibility contract just because the code would execute there.
 * Supporting a version means keeping it working, and this one receives no security
 * fixes upstream.
 */
export const MINIMUM_NODE_VERSION: NodeVersionRequirement = { major: 22, minor: 0, patch: 0 };

export const MINIMUM_NODE_VERSION_LABEL = `${MINIMUM_NODE_VERSION.major}.${MINIMUM_NODE_VERSION.minor}.${MINIMUM_NODE_VERSION.patch}`;

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

const databaseUrlSchema = z.string().trim().refine(isPostgresConnectionString, {
  message:
    'must be a PostgreSQL connection string, for example postgresql://user:password@host:5432/postgres?sslmode=require',
});

/**
 * A project ref is not a secret, so the message may describe the expected shape — but
 * it still must not echo what was supplied, because an operator who pasted the wrong
 * variable into it would otherwise have their token printed back at them.
 */
const projectRefSchema = z
  .string()
  .trim()
  .regex(PROJECT_REF_PATTERN, {
    message: `must be a ${String(PROJECT_REF_LENGTH)}-character Supabase project ref (lowercase letters and digits), as shown in your project URL`,
  });

/**
 * The token is checked for presence only.
 *
 * Personal access tokens, OAuth tokens and future token formats do not share a stable
 * prefix, so a pattern here would reject valid credentials for no security gain. More
 * importantly, a validation failure message must never describe the value it rejected:
 * "expected a token starting with sbp_, got sbp_live_9f2..." is a secret disclosure
 * with a helpful tone.
 */
const accessTokenSchema = z.string().trim().min(1);

const environmentSchema = z.object({
  SUPABASE_DB_URL: z.preprocess(blankToUndefined, databaseUrlSchema.optional()),
  SUPABASE_PROJECT_REF: z.preprocess(blankToUndefined, projectRefSchema.optional()),
  SUPABASE_ACCESS_TOKEN: z.preprocess(blankToUndefined, accessTokenSchema.optional()),
});

/** Environment variables this tool reads. Documented in `.env.example`. */
export const KNOWN_ENVIRONMENT_VARIABLES = [
  'SUPABASE_DB_URL',
  'SUPABASE_PROJECT_REF',
  'SUPABASE_ACCESS_TOKEN',
] as const;

/**
 * Validates the given environment (defaults to the process environment).
 *
 * @throws ConfigurationError when a variable is present but invalid. The offending
 * value is never included in the message, because it is a credential.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse({
    SUPABASE_DB_URL: env['SUPABASE_DB_URL'],
    SUPABASE_PROJECT_REF: env['SUPABASE_PROJECT_REF'],
    SUPABASE_ACCESS_TOKEN: env['SUPABASE_ACCESS_TOKEN'],
  });

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'} ${issue.message}`)
      .join('; ');

    throw new ConfigurationError(`Invalid configuration: ${details}`, {
      hint: 'Check your environment variables against .env.example.',
    });
  }

  return {
    databaseUrl: result.data.SUPABASE_DB_URL,
    projectRef: result.data.SUPABASE_PROJECT_REF,
    accessToken: result.data.SUPABASE_ACCESS_TOKEN,
  };
}

/**
 * Asserts a database connection string is configured, for a command that needs one.
 *
 * @throws ConfigurationError naming the command, so the hint is actionable.
 */
export function requireDatabaseUrl(config: AppConfig, command: string): string {
  if (config.databaseUrl === undefined) {
    throw new ConfigurationError('SUPABASE_DB_URL is missing', {
      hint: `Set SUPABASE_DB_URL (see .env.example) and run \`${CLI_NAME} ${command}\` again.`,
    });
  }

  return config.databaseUrl;
}

/**
 * Asserts both Management API credentials are configured.
 *
 * Both are named in one error rather than one per run, so an operator setting the tool
 * up for the first time learns everything they are missing in a single attempt instead
 * of discovering the second variable only after fixing the first.
 *
 * The token's *value* is never touched here beyond the presence check performed at load
 * time, and never appears in the thrown message.
 */
export function requireManagementCredentials(
  config: AppConfig,
  command: string,
): ManagementCredentials {
  const missing: string[] = [];
  if (config.projectRef === undefined) {
    missing.push('SUPABASE_PROJECT_REF');
  }
  if (config.accessToken === undefined) {
    missing.push('SUPABASE_ACCESS_TOKEN');
  }

  if (config.projectRef === undefined || config.accessToken === undefined) {
    throw new ConfigurationError(
      `Supabase Management API credentials are missing: ${missing.join(' and ')}`,
      {
        hint: `Set them (see .env.example) and run \`${CLI_NAME} ${command}\` again. Create a token at https://supabase.com/dashboard/account/tokens.`,
      },
    );
  }

  return { projectRef: config.projectRef, accessToken: config.accessToken };
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
