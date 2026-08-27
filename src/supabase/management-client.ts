/**
 * The only place this project makes an authenticated network request.
 *
 * `src/blocklist/fetch.ts` downloads a public file with no credential attached; this
 * module sends a Management API token that can read and rewrite a project's
 * authentication configuration. That difference drives every decision here.
 *
 * **Where the token may go.** Into the `Authorization` header of a request to the
 * compiled-in Management API origin, and nowhere else. Not into a URL, a query string,
 * a log line, an error message, a file, or a process argument. The base URL is a
 * constant rather than a setting precisely so there is no input that can redirect an
 * authenticated request to an attacker-chosen host — the same reasoning that keeps the
 * blocklist provider list compiled in.
 *
 * **What the response is.** Attacker-influenceable data, exactly like a downloaded
 * blocklist, and it is treated as such: HTTPS only, a request timeout, a streamed byte
 * ceiling, a content-type check, a schema that validates only the fields we use, and
 * sanitisation of any server text before it reaches a terminal. Response bodies are
 * never logged wholesale, because the Auth configuration document contains SMTP
 * passwords, OAuth client secrets and SMS provider tokens that this tool has no reason
 * to read and every reason not to print.
 *
 * **No retries.** A GET could safely be retried, but a PATCH could not, and an
 * automatic retry layer that treats the two differently is more machinery than a
 * foreground CLI command needs. Post-write verification, not a retry, is what protects
 * against an ambiguous outcome; a transient failure is reported and the operator reruns
 * the command.
 */

import { z } from 'zod';

import { SupabaseApiError } from '../lib/errors.js';
import { CLI_NAME, getPackageVersion } from '../lib/package-info.js';
import { sanitizeForDisplay } from '../lib/redact.js';
import {
  ACCEPTED_CONTENT_TYPES,
  AUTH_CONFIG_PATH_SEGMENTS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MANAGEMENT_API_BASE_URL,
  MAX_SERVER_MESSAGE_LENGTH,
  PROJECT_REF_PATTERN,
} from './constants.js';
import type { BeforeUserCreatedHookPatch } from './types.js';

/**
 * The fields this tool reads from the Auth configuration document.
 *
 * `.loose()` is load-bearing, not laziness: Supabase adds Auth settings regularly, and a
 * strict schema would make an unrelated new field break every `hook` command until this
 * package was updated. Unknown keys are carried through the parse and then discarded by
 * the caller, which never reads them.
 *
 * Both fields are `nullable` in the published schema and may be absent entirely on a
 * project that has never configured the hook, so all three shapes are accepted.
 */
const authConfigSchema = z.looseObject({
  hook_before_user_created_enabled: z.boolean().nullish(),
  hook_before_user_created_uri: z.string().nullish(),
});

/** The validated slice of a GET response. */
export type AuthConfigDocument = z.infer<typeof authConfigSchema>;

export interface ManagementClientOptions {
  /** Secret. Sent only as an `Authorization: Bearer` header value. */
  readonly accessToken: string;
  /**
   * Origin of the Management API.
   *
   * **Dependency injection for tests only.** Nothing wires this to a flag, an
   * environment variable or a config file, and nothing ever should: a settable API
   * origin turns a CLI holding a Management API token into a credential-exfiltration
   * primitive. It is still required to be HTTPS, so even a test cannot accidentally
   * establish a plaintext habit.
   */
  readonly baseUrl?: string;
  /** Injected by tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

/**
 * A narrow client for the two Auth-configuration operations this tool performs.
 *
 * There is deliberately no generic `request()` method on the public surface. A general
 * "call any Management API endpoint" helper invites a future command to reach for an
 * endpoint nobody reviewed, with a token that can do a great deal more than configure a
 * hook, and the value of a small blast radius is that it stays small.
 */
export class ManagementClient {
  private readonly accessToken: string;
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly signal: AbortSignal | undefined;

  constructor(options: ManagementClientOptions) {
    this.accessToken = options.accessToken;
    this.baseUrl = assertHttpsUrl(options.baseUrl ?? MANAGEMENT_API_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.signal = options.signal;
  }

  /** Reads the project's Auth configuration. Requires Auth-configuration read access. */
  async getAuthConfig(projectRef: string): Promise<AuthConfigDocument> {
    return this.send('GET', projectRef, undefined);
  }

  /**
   * Applies a partial update to the project's Auth configuration.
   *
   * `patch` must contain **only** the fields this feature owns. Reading the whole
   * document and sending it back would rewrite every unrelated Auth setting with values
   * that were already stale by the time the response arrived — including secrets the
   * API may return redacted, which would then be written back redacted. The type of
   * `patch` exists to make that mistake impossible to express.
   */
  async updateAuthConfig(
    projectRef: string,
    patch: BeforeUserCreatedHookPatch,
  ): Promise<AuthConfigDocument> {
    return this.send('PATCH', projectRef, patch);
  }

  private async send(
    method: 'GET' | 'PATCH',
    projectRef: string,
    body: BeforeUserCreatedHookPatch | undefined,
  ): Promise<AuthConfigDocument> {
    const url = this.authConfigUrl(projectRef);

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal =
      this.signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, this.signal]);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        // Manual, so a redirect can never carry the Authorization header to another
        // host. `follow` would let the runtime decide, and the Management API has no
        // legitimate reason to redirect these endpoints.
        redirect: 'manual',
        signal,
        headers: {
          // The one and only place the token appears.
          authorization: `Bearer ${this.accessToken}`,
          accept: 'application/json',
          'user-agent': `${CLI_NAME}/${getPackageVersion()}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw describeTransportFailure(
        cause,
        method,
        timeoutSignal,
        this.timeoutMs,
        this.accessToken,
      );
    }

    if (isRedirect(response.status)) {
      await discard(response);
      throw new SupabaseApiError(
        `The Supabase Management API redirected the ${method} request unexpectedly (HTTP ${String(response.status)})`,
        {
          hint: 'A redirect is never followed on an authenticated request. Check https://status.supabase.com and try again.',
        },
      );
    }

    if (!response.ok) {
      throw await this.describeErrorStatus(response, method);
    }

    assertAcceptedContentType(response, method);

    const text = await this.readBody(response, method, timeoutSignal);
    return parseAuthConfig(text, method);
  }

  /**
   * Builds the endpoint URL with the project ref bound as a single path segment.
   *
   * The ref is re-validated here even though configuration already validated it. This
   * function is the last thing standing between a value and an authenticated request
   * path, and a check at the boundary that performs the dangerous operation does not
   * depend on every future caller having done the right thing first.
   *
   * Segments are appended through `URL` rather than concatenated into a template
   * string, so a value containing `..` or `/` cannot walk the path to another endpoint.
   * The ref pattern already forbids both; this is the second lock on the same door.
   */
  private authConfigUrl(projectRef: string): URL {
    if (!PROJECT_REF_PATTERN.test(projectRef)) {
      throw new SupabaseApiError('The Supabase project ref is not in a valid format', {
        hint: 'SUPABASE_PROJECT_REF must be the 20-character ref shown in your project URL.',
      });
    }

    const url = new URL(this.baseUrl.href);
    url.pathname = AUTH_CONFIG_PATH_SEGMENTS.map((segment) =>
      segment === ':ref' ? encodeURIComponent(projectRef) : segment,
    ).join('/');

    // Defence in depth: if any of the above ever produced something that escaped the
    // intended origin, refuse rather than send a token to it.
    if (url.origin !== this.baseUrl.origin) {
      throw new SupabaseApiError('Refusing to send credentials to an unexpected host');
    }

    return url;
  }

  /**
   * Turns a non-2xx response into an actionable error.
   *
   * The status drives the message, because the status is the part we can trust. Any
   * server-supplied text is sanitised, truncated and placed in the hint — useful
   * ("Auth Hooks can only be configured on Team or Enterprise Plans" is precisely what
   * an operator needs) without being treated as authoritative.
   */
  private async describeErrorStatus(response: Response, method: string): Promise<SupabaseApiError> {
    const detail = await this.readErrorDetail(response);
    const suffix = detail === undefined ? '' : ` Supabase said: ${detail}`;

    switch (response.status) {
      case 401:
        return new SupabaseApiError('Supabase rejected the Management API access token', {
          hint: `The token is missing, expired or revoked. Create a new one at https://supabase.com/dashboard/account/tokens and set SUPABASE_ACCESS_TOKEN.${suffix}`,
        });
      case 403:
        return new SupabaseApiError(
          'The Management API access token is not permitted to perform this operation',
          {
            hint: `Reading Auth configuration needs auth:read; changing it needs auth:write. Check the token's scopes and that the account can administer this project.${suffix}`,
          },
        );
      case 404:
        return new SupabaseApiError('Supabase does not recognise this project ref', {
          hint: `Check SUPABASE_PROJECT_REF, and that the token's account has access to that project.${suffix}`,
        });
      case 429:
        return new SupabaseApiError('The Supabase Management API rate-limited this request', {
          hint: `Nothing was changed. Wait a moment and run the command again — it does not retry automatically.${suffix}`,
        });
      default:
        break;
    }

    if (response.status >= 500) {
      return new SupabaseApiError(
        `The Supabase Management API is unavailable (HTTP ${String(response.status)})`,
        {
          hint: `Check https://status.supabase.com and try again. The ${method} request may not have been applied — rerun the command to find out.${suffix}`,
        },
      );
    }

    return new SupabaseApiError(
      `The Supabase Management API refused the ${method} request (HTTP ${String(response.status)})`,
      { hint: `Nothing was changed.${suffix}` },
    );
  }

  /**
   * Extracts a short, printable message from an error body.
   *
   * Error bodies are small and are not the Auth configuration document, so reading one
   * does not risk printing a secret the way echoing a success body would. It is still
   * remote text: only a string-valued `message` or `msg` is considered, and the result
   * is sanitised, token-redacted and capped. A body that is not JSON, or has no such
   * field, yields nothing rather than a raw dump.
   *
   * The redaction step exists because of a case that is easy to miss: **the server can
   * put our own token in its reply.** An authentication error that helpfully quotes the
   * credential it rejected — or a proxy, or a WAF — turns "echo the server's message"
   * into a disclosure path that no amount of care on this side would otherwise close.
   * The token is a value this client holds, so it can simply be removed.
   */
  private async readErrorDetail(response: Response): Promise<string | undefined> {
    let text: string;
    try {
      text = await response.text();
    } catch {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }

    const shape = z
      .looseObject({ message: z.string().optional(), msg: z.string().optional() })
      .safeParse(parsed);
    if (!shape.success) {
      return undefined;
    }

    const message = shape.data.message ?? shape.data.msg;
    if (message === undefined || message.trim() === '') {
      return undefined;
    }

    return sanitizeForDisplay(this.redactToken(message.trim()), MAX_SERVER_MESSAGE_LENGTH);
  }

  /**
   * Removes the access token from text that is about to be shown to a human.
   *
   * A plain substring replacement rather than a regular expression: the token is
   * arbitrary text and building a pattern from it risks both escaping bugs and a
   * catastrophic backtrack. Redaction happens before truncation, so a token cannot
   * survive by sitting past the length cap and being cut in half into something that
   * still discloses most of it.
   */
  private redactToken(value: string): string {
    return redactSecret(value, this.accessToken);
  }

  /** Reads the body chunk by chunk, aborting the moment the ceiling is crossed. */
  private async readBody(
    response: Response,
    method: string,
    timeoutSignal: AbortSignal,
  ): Promise<string> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      throw new SupabaseApiError('The Supabase Management API response is too large', {
        hint: `Declared ${String(declared)} bytes, limit is ${String(this.maxBytes)}. Nothing was changed.`,
      });
    }

    const body = response.body;
    if (body === null) {
      return '';
    }

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
        if (total > this.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new SupabaseApiError('The Supabase Management API response is too large', {
            hint: `Refused after ${String(this.maxBytes)} bytes. Nothing was changed.`,
          });
        }

        chunks.push(value);
      }
    } catch (cause) {
      if (cause instanceof SupabaseApiError) {
        throw cause;
      }
      throw describeTransportFailure(cause, method, timeoutSignal, undefined, this.accessToken);
    }

    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return new TextDecoder('utf-8').decode(combined);
  }
}

/**
 * Validates the response against the two fields we use.
 *
 * Neither the raw text nor the parsed object is ever included in the error, no matter
 * how much easier that would make debugging. This document holds SMTP passwords, OAuth
 * client secrets and SMS provider credentials; a malformed-response error is not worth
 * printing any of them to a terminal.
 */
function parseAuthConfig(text: string, method: string): AuthConfigDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SupabaseApiError(
      `The Supabase Management API returned a ${method} response that is not valid JSON`,
      {
        hint: 'Nothing was changed. Try again; if it persists, check https://status.supabase.com.',
      },
    );
  }

  const result = authConfigSchema.safeParse(parsed);
  if (!result.success) {
    // Field names and issue codes only -- never the values, which are the secrets.
    const fields = result.error.issues
      .map((issue) => issue.path.join('.') || 'response')
      .filter((field, index, all) => all.indexOf(field) === index)
      .join(', ');

    throw new SupabaseApiError(
      `The Supabase Management API returned an Auth configuration this version does not understand (unexpected: ${fields})`,
      {
        hint: 'Nothing was changed. Upgrade this CLI; the Auth configuration contract may have changed.',
      },
    );
  }

  return result.data;
}

/** Requires the declared content type to be JSON. */
function assertAcceptedContentType(response: Response, method: string): void {
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();

  if (
    mediaType === undefined ||
    !ACCEPTED_CONTENT_TYPES.includes(mediaType as 'application/json')
  ) {
    throw new SupabaseApiError(
      `The Supabase Management API returned a non-JSON ${method} response`,
      {
        hint: `Expected ${ACCEPTED_CONTENT_TYPES.join(', ')}. This usually means a proxy or captive portal answered instead of Supabase.`,
      },
    );
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * Turns a transport-level throw into a specific, actionable error.
 *
 * A timeout and a cancellation both surface as `AbortError`, and telling an operator
 * "aborted" when the answer is "Supabase did not respond in 15 seconds" wastes their
 * time. Note what is deliberately absent: the URL. It contains the project ref, which
 * is harmless, but keeping every network diagnostic URL-free removes an entire class of
 * accidental disclosure if a credential ever ends up somewhere it should not.
 */
function describeTransportFailure(
  cause: unknown,
  method: string,
  timeoutSignal: AbortSignal,
  timeoutMs: number | undefined,
  accessToken: string,
): SupabaseApiError {
  // The cause is scrubbed before it is attached, not before it is printed. `--debug`
  // renders `cause.stack` verbatim, and a transport error raised by the runtime -- or by
  // an interceptor, a proxy shim, or a test double -- can carry request detail in its
  // own message. Sanitising at the point of attachment means no future rendering path
  // has to remember to do it.
  const safeCause = redactCause(cause, accessToken);

  if (timeoutSignal.aborted) {
    const limit = timeoutMs === undefined ? '' : ` after ${String(timeoutMs)} ms`;
    return new SupabaseApiError(
      `Timed out talking to the Supabase Management API${limit} (${method})`,
      {
        cause: safeCause,
        hint: 'Check connectivity and https://status.supabase.com, then run the command again.',
      },
    );
  }

  if (cause instanceof Error && cause.name === 'AbortError') {
    return new SupabaseApiError(`The ${method} request to Supabase was cancelled`, {
      cause: safeCause,
    });
  }

  return new SupabaseApiError('Could not reach the Supabase Management API', {
    cause: safeCause,
    hint: 'Check network connectivity and https://status.supabase.com.',
  });
}

/**
 * Removes a secret from arbitrary text.
 *
 * A plain substring replacement rather than a regular expression: the token is arbitrary
 * text, and building a pattern from it risks both escaping bugs and catastrophic
 * backtracking. An empty token is a no-op so the helper is safe to call unconditionally.
 */
function redactSecret(value: string, secret: string): string {
  return secret === '' ? value : value.split(secret).join('[redacted]');
}

/**
 * Returns a copy of an error with the token removed from its message and stack.
 *
 * A copy, not a mutation: the original belongs to whoever threw it, and rewriting
 * another library's error object in place is the kind of action-at-a-distance that makes
 * unrelated debugging miserable. Anything that is not an `Error` is reduced to a
 * redacted string, because an arbitrary thrown value may be an object whose own
 * serialisation carries the secret.
 */
function redactCause(cause: unknown, accessToken: string): unknown {
  if (accessToken === '') {
    return cause;
  }

  if (cause instanceof Error) {
    const copy = new Error(redactSecret(cause.message, accessToken));
    copy.name = cause.name;
    if (cause.stack !== undefined) {
      copy.stack = redactSecret(cause.stack, accessToken);
    }
    return copy;
  }

  return redactSecret(String(cause), accessToken);
}

/** Rejects a base URL that is not HTTPS, before a token is ever attached to it. */
function assertHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SupabaseApiError('The Management API base URL is not a valid URL');
  }

  if (url.protocol !== 'https:') {
    throw new SupabaseApiError(
      `Refusing to send Management API credentials over ${url.protocol}//`,
    );
  }

  return url;
}

/** Drains a response we are not going to use, so the connection can be reused. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing useful to do; the real error is the one being reported.
  }
}
