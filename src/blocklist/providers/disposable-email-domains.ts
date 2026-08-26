/**
 * The `disposable/disposable-email-domains` provider.
 *
 * Upstream: https://github.com/disposable/disposable-email-domains
 * Endpoint: https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.txt
 * Licence:  MIT (the dataset is redistributed by this tool only into the user's own
 *           database; nothing is vendored into this repository)
 *
 * Why this dataset: it is actively maintained, aggregates several upstream lists, and
 * publishes a plain-text file of one domain per line -- roughly 1.1 MB and ~150,000
 * entries at the time of writing.
 *
 * Why the raw endpoint specifically:
 *  - It is a stable, documented data URL, not a rendered page. Nothing here parses
 *    HTML, so a redesign of GitHub's UI cannot break or poison this tool.
 *  - It requires no authentication, so the CLI never needs a GitHub token and there is
 *    no credential to leak.
 *  - It is served as `text/plain`, which lets the fetch layer reject an HTML error
 *    page outright instead of parsing it into a blocklist.
 *
 * Pinning to `master` rather than a tag or a commit is a deliberate trade-off: the
 * point of sync is to track upstream, and a pinned commit would freeze the list. The
 * risk that creates -- a compromised or truncated upstream -- is answered by the
 * safety thresholds in `safety.ts`, not by pinning.
 */

import { fetchText } from '../fetch.js';
import type { BlocklistProvider, ProviderFetchOptions, RawBlocklist } from '../types.js';

export const DISPOSABLE_EMAIL_DOMAINS_SOURCE = 'disposable-email-domains';

const URL =
  'https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.txt';

const UPSTREAM = 'https://github.com/disposable/disposable-email-domains';

/** The upstream serves `text/plain; charset=utf-8`. Nothing else is accepted. */
const ACCEPTED_CONTENT_TYPES = ['text/plain'] as const;

export const disposableEmailDomainsProvider: BlocklistProvider = {
  name: DISPOSABLE_EMAIL_DOMAINS_SOURCE,
  source: DISPOSABLE_EMAIL_DOMAINS_SOURCE,
  url: URL,
  upstream: UPSTREAM,

  async fetch(options: ProviderFetchOptions = {}): Promise<RawBlocklist> {
    const result = await fetchText({
      url: URL,
      acceptedContentTypes: ACCEPTED_CONTENT_TYPES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

    return {
      provider: DISPOSABLE_EMAIL_DOMAINS_SOURCE,
      source: DISPOSABLE_EMAIL_DOMAINS_SOURCE,
      url: result.url,
      body: result.body,
      bytes: result.bytes,
      status: result.status,
      contentType: result.contentType,
      durationMs: result.durationMs,
    };
  },
};
