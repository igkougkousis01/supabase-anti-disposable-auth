/**
 * The only place this project talks to the network.
 *
 * Everything here exists because the response is attacker-influenced data from a
 * third party. The controls, and what each one is for:
 *
 *  - **HTTPS only**, on the initial URL and on every redirect target. A downgrade to
 *    plaintext would let anyone on the path replace the blocklist wholesale.
 *  - **Manual redirect handling**, capped at a small number of hops. `redirect:
 *    'follow'` would hand the decision to the runtime, including the decision to
 *    follow an `https:` -> `http:` hop, so the redirect chain is walked here where
 *    each target can be checked.
 *  - **A request timeout**, so an upstream that accepts the connection and then stalls
 *    cannot hang the CLI indefinitely. It covers the body too, not just the headers.
 *  - **A hard byte ceiling enforced while streaming.** `Content-Length` is a claim, not
 *    a fact, so the limit is applied to bytes actually received and the stream is
 *    cancelled the moment it is exceeded. An upstream cannot stream unbounded data
 *    into memory.
 *  - **A content-type allowlist**, which is what turns "GitHub served me an HTML error
 *    page with HTTP 200" from a corrupted blocklist into a clean failure.
 *
 * The response body is data. It is never executed, never evaluated, never written to
 * disk, and never passed to a shell.
 */

import { BlocklistFetchError } from '../lib/errors.js';
import { CLI_NAME, getPackageVersion } from '../lib/package-info.js';

/**
 * 15 seconds.
 *
 * A ~1 MB text file over a healthy link completes in well under a second; this leaves
 * generous room for a slow or congested connection while still failing inside the
 * attention span of someone watching a terminal. Manual sync is a foreground command,
 * so a long silent wait is worse than a clear failure the user can retry.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 8 MiB.
 *
 * The supported upstream list is ~1.1 MB today. Eight gives roughly seven times
 * headroom -- years of upstream growth -- while capping what a hostile or broken
 * server can force this process to allocate. It is a constant rather than a setting
 * because there is no legitimate reason for an operator to raise it, and every reason
 * a compromised upstream would want them to.
 */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Three hops.
 *
 * The supported endpoint answers 200 directly. A couple of hops covers a legitimate
 * upstream reorganisation; more than that is a loop or a redirector being abused.
 */
export const DEFAULT_MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchTextOptions {
  readonly url: string;
  readonly acceptedContentTypes: readonly string[];
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly signal?: AbortSignal;
  /** Injected by tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface FetchTextResult {
  /** The URL that actually served the body, which may differ after a redirect. */
  readonly url: string;
  readonly status: number;
  readonly contentType: string | undefined;
  readonly bytes: number;
  readonly body: string;
  readonly durationMs: number;
}

/**
 * Downloads a text document under every control described above.
 *
 * @throws BlocklistFetchError for anything that goes wrong. The message names the
 * upstream URL, which is public; no credential is ever part of this request.
 */
export async function fetchText(options: FetchTextOptions): Promise<FetchTextResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const startedAt = Date.now();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, options.signal]);

  let url = assertHttpsUrl(options.url);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await request(fetchImpl, url, signal, timeoutSignal, timeoutMs);

    if (REDIRECT_STATUSES.has(response.status)) {
      // The body of a redirect is of no interest and must not be left unread.
      await discard(response);

      if (hop === maxRedirects) {
        throw new BlocklistFetchError(`Too many redirects while downloading ${url.href}`, {
          hint: `The upstream redirected more than ${maxRedirects} times. It may be misconfigured.`,
        });
      }

      url = resolveRedirect(response, url);
      continue;
    }

    if (!response.ok) {
      await discard(response);
      throw new BlocklistFetchError(
        `The upstream returned HTTP ${response.status} for ${url.href}`,
        { hint: 'The installed blocklist was left unchanged. Try again later.' },
      );
    }

    const contentType = response.headers.get('content-type') ?? undefined;
    assertAcceptedContentType(contentType, options.acceptedContentTypes, url);
    assertDeclaredSizeWithinLimit(response, maxBytes, url);

    const bytes = await readBody(response, maxBytes, url, timeoutSignal);

    return {
      url: url.href,
      status: response.status,
      contentType,
      bytes: bytes.byteLength,
      // `fatal: false` keeps a mis-encoded byte as U+FFFD instead of throwing; the
      // parser's binary heuristic counts those and refuses the payload, which gives a
      // far better message than a decoder exception.
      body: new TextDecoder('utf-8').decode(bytes),
      durationMs: Date.now() - startedAt,
    };
  }

  // Unreachable: the loop either returns or throws.
  throw new BlocklistFetchError(`Could not download ${url.href}`);
}

async function request(
  fetchImpl: typeof fetch,
  url: URL,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: 'GET',
      // Manual, so every hop is checked here rather than followed blindly.
      redirect: 'manual',
      signal,
      headers: {
        accept: 'text/plain',
        'user-agent': `${CLI_NAME}/${getPackageVersion()}`,
      },
    });
  } catch (cause) {
    throw describeTransportFailure(cause, url, timeoutSignal, timeoutMs);
  }
}

/** Reads the body chunk by chunk, aborting the moment the ceiling is crossed. */
async function readBody(
  response: Response,
  maxBytes: number,
  url: URL,
  timeoutSignal: AbortSignal,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    return new Uint8Array(0);
  }

  // Node types `Response.body` as `ReadableStream<any>`; narrowing it here keeps the
  // byte arithmetic below type-safe rather than silently `any`.
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BlocklistFetchError(`The upstream response from ${url.href} is too large`, {
          hint: `Refused after ${maxBytes} bytes. The installed blocklist was left unchanged.`,
        });
      }

      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof BlocklistFetchError) {
      throw cause;
    }
    throw describeTransportFailure(cause, url, timeoutSignal, undefined);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return combined;
}

/** Rejects a URL that is not HTTPS, before a single byte is sent. */
function assertHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BlocklistFetchError('The provider URL is not a valid URL');
  }

  if (url.protocol !== 'https:') {
    throw new BlocklistFetchError(`Refusing to download over ${url.protocol}//`, {
      hint: 'Blocklist sources must be served over HTTPS.',
    });
  }

  return url;
}

function resolveRedirect(response: Response, from: URL): URL {
  const location = response.headers.get('location');
  if (location === null || location === '') {
    throw new BlocklistFetchError(`The upstream redirected ${from.href} without a target`);
  }

  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    throw new BlocklistFetchError(`The upstream redirected ${from.href} to an invalid URL`);
  }

  if (target.protocol !== 'https:') {
    throw new BlocklistFetchError(
      `Refusing to follow a redirect from ${from.href} to ${target.protocol}//`,
      { hint: 'A redirect away from HTTPS is never followed. The blocklist was left unchanged.' },
    );
  }

  return target;
}

/**
 * Requires the declared content type to be one we expect.
 *
 * This is the control that catches the "200 OK with an HTML error page" case, which is
 * exactly how a CDN or a repository host reports a problem. Parameters such as
 * `; charset=utf-8` are ignored; only the media type is compared.
 */
function assertAcceptedContentType(
  contentType: string | undefined,
  accepted: readonly string[],
  url: URL,
): void {
  const mediaType = contentType?.split(';')[0]?.trim().toLowerCase();

  if (mediaType === undefined || mediaType === '') {
    throw new BlocklistFetchError(`The upstream at ${url.href} declared no content type`, {
      hint: `Expected one of: ${accepted.join(', ')}.`,
    });
  }

  if (!accepted.includes(mediaType)) {
    throw new BlocklistFetchError(
      `The upstream at ${url.href} returned "${mediaType}" instead of a plain-text list`,
      {
        hint: `Expected one of: ${accepted.join(', ')}. The installed blocklist was left unchanged.`,
      },
    );
  }
}

/** Fails fast on an honestly-declared oversized body, before streaming any of it. */
function assertDeclaredSizeWithinLimit(response: Response, maxBytes: number, url: URL): void {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BlocklistFetchError(`The upstream response from ${url.href} is too large`, {
      hint: `Declared ${declared} bytes, limit is ${maxBytes}. The installed blocklist was left unchanged.`,
    });
  }
}

/**
 * Turns a transport-level throw into a specific, actionable error.
 *
 * A timeout and a user-initiated cancellation both surface as an `AbortError`, and
 * telling an operator "aborted" when the real answer is "the upstream did not respond
 * in 15 seconds" wastes their time.
 */
function describeTransportFailure(
  cause: unknown,
  url: URL,
  timeoutSignal: AbortSignal,
  timeoutMs: number | undefined,
): BlocklistFetchError {
  if (timeoutSignal.aborted) {
    const limit = timeoutMs === undefined ? '' : ` after ${timeoutMs} ms`;
    return new BlocklistFetchError(`Timed out downloading ${url.href}${limit}`, {
      cause,
      hint: 'The installed blocklist was left unchanged. Try again when the upstream responds.',
    });
  }

  if (cause instanceof Error && cause.name === 'AbortError') {
    return new BlocklistFetchError(`Download of ${url.href} was cancelled`, { cause });
  }

  return new BlocklistFetchError(`Could not reach ${url.href}`, {
    cause,
    hint: 'Check network connectivity. The installed blocklist was left unchanged.',
  });
}

/** Drains a response we are not going to use, so the connection can be reused. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing useful to do; the real error is the one being reported.
  }
}
