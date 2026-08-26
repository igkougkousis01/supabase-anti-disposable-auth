/** Types shared by the blocklist pipeline. Kept free of `pg` and of `fetch` specifics. */

/**
 * A source of disposable-domain data.
 *
 * The abstraction is deliberately thin. One production provider exists today, and the
 * only thing a second one would need is a different URL and a different accepted
 * content type -- so the interface describes exactly that and nothing more. No
 * provider-specific behaviour leaks into the pipeline: `sync.ts` knows it has a
 * provider, not which one.
 */
export interface BlocklistProvider {
  /** Human-facing name, shown in CLI output. */
  readonly name: string;
  /**
   * Stable identifier written to `guard.blocked_domains.source` and used as the
   * primary key of `guard.sync_metadata`. Changing it orphans a source's history, so
   * it is treated as permanent.
   */
  readonly source: string;
  /** The exact URL fetched. Public, contains no credential, safe to print. */
  readonly url: string;
  /** Upstream project this data comes from, for documentation and attribution. */
  readonly upstream: string;
  fetch(options?: ProviderFetchOptions): Promise<RawBlocklist>;
}

export interface ProviderFetchOptions {
  /** Caller-supplied cancellation, combined with the provider's own timeout. */
  readonly signal?: AbortSignal;
  /** Injected by tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** What a provider returns: bytes plus enough metadata to explain what happened. */
export interface RawBlocklist {
  readonly provider: string;
  readonly source: string;
  readonly url: string;
  /** Decoded response body. Never logged in full. */
  readonly body: string;
  readonly bytes: number;
  readonly status: number;
  readonly contentType: string | undefined;
  readonly durationMs: number;
}
