/**
 * Provider registry.
 *
 * One production provider exists. The registry is here so a second one is a new file
 * plus one line, not a refactor -- but it is deliberately not a plugin system: there
 * is no dynamic loading, no configuration file, and no way to point the tool at an
 * arbitrary URL. Accepting a caller-supplied URL would turn this CLI into an SSRF
 * primitive that runs with database credentials in its environment, so that capability
 * is intentionally absent rather than merely unimplemented.
 */

import { SyncError } from '../lib/errors.js';
import {
  disposableEmailDomainsProvider,
  DISPOSABLE_EMAIL_DOMAINS_SOURCE,
} from './providers/disposable-email-domains.js';
import type { BlocklistProvider } from './types.js';

export const PROVIDERS: readonly BlocklistProvider[] = [disposableEmailDomainsProvider];

export const DEFAULT_PROVIDER_NAME = DISPOSABLE_EMAIL_DOMAINS_SOURCE;

/**
 * Resolves a provider by name, defaulting to the only one that exists.
 *
 * @throws SyncError for an unknown name, listing the ones that do exist.
 */
export function getProvider(name: string = DEFAULT_PROVIDER_NAME): BlocklistProvider {
  const provider = PROVIDERS.find((candidate) => candidate.name === name);
  if (provider === undefined) {
    throw new SyncError(`Unknown blocklist provider: ${name}`, {
      hint: `Available providers: ${PROVIDERS.map((candidate) => candidate.name).join(', ')}.`,
    });
  }

  return provider;
}
