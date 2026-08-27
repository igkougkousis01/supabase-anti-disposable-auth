/**
 * Doubles for the Supabase Management API.
 *
 * No unit test in this repository is allowed to touch the network, and this module is
 * the reason the Management API tests can be exhaustive: every status code, every
 * malformed body and every timeout is producible here in a line.
 *
 * The client under test is always the **real** {@link ManagementClient} driven by a fake
 * `fetch`, never a mock of the client itself. Mocking the client would leave its actual
 * safety controls — the HTTPS check, the byte ceiling, the content-type check, the
 * Authorization header — untested, which is precisely the code that matters here.
 */

import { ManagementClient } from '../../src/supabase/management-client.js';
import { BEFORE_USER_CREATED_HOOK_URI } from '../../src/supabase/constants.js';

/**
 * A sentinel access token.
 *
 * Every secret-leak test asserts this exact string is absent from output. It is
 * deliberately unmistakable so that a match in a diff or a CI log is unambiguous.
 */
export const SENTINEL_TOKEN = 'SUPER_SECRET_SENTINEL';

/** A syntactically valid project ref: 20 lowercase characters. */
export const TEST_PROJECT_REF = 'abcdefghijklmnopqrst';

export interface AuthConfigFields {
  readonly hook_before_user_created_enabled?: boolean | null;
  readonly hook_before_user_created_uri?: string | null;
}

/**
 * A believable Auth configuration response.
 *
 * Padded with unrelated fields on purpose. The real document has some two hundred of
 * them, several holding secrets, and a schema that broke on an unexpected key would
 * break every `hook` command the next time Supabase shipped a setting. These extras
 * assert that tolerance, and that nothing prints them.
 */
export function authConfigResponse(fields: AuthConfigFields = {}, status = 200): Response {
  const body = JSON.stringify({
    site_url: 'https://example.test',
    smtp_pass: 'UNRELATED_SMTP_PASSWORD',
    external_google_secret: 'UNRELATED_OAUTH_SECRET',
    hook_before_user_created_secrets: 'UNRELATED_HOOK_SECRET',
    disable_signup: false,
    ...fields,
  });

  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The hook slot as a project that has never configured it reports it. */
export function unconfigured(): AuthConfigFields {
  return { hook_before_user_created_enabled: false, hook_before_user_created_uri: '' };
}

/** The hook slot pointing at this tool's function. */
export function ours(enabled: boolean): AuthConfigFields {
  return {
    hook_before_user_created_enabled: enabled,
    hook_before_user_created_uri: BEFORE_USER_CREATED_HOOK_URI,
  };
}

/** The hook slot pointing at somebody else's function. */
export function foreign(
  enabled: boolean,
  uri = 'pg-functions://postgres/custom/existing_hook',
): AuthConfigFields {
  return { hook_before_user_created_enabled: enabled, hook_before_user_created_uri: uri };
}

/** A structured API error body, as the Management API returns for a rejected request. */
export function errorResponse(status: number, message?: string): Response {
  const body = JSON.stringify({ message: message ?? 'something went wrong' });
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

export interface ManagementApiDouble {
  readonly client: ManagementClient;
  /** Every request the client made, in order. */
  readonly requests: RecordedRequest[];
  /** Requests that would have changed remote state. */
  readonly patches: () => RecordedRequest[];
}

export interface ManagementApiDoubleOptions {
  readonly accessToken?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/**
 * A client backed by a queue of canned responses, recording everything it sends.
 *
 * A queued entry may be a thunk, so a test can throw a transport error from the exact
 * position in the sequence it wants to exercise — for instance, failing the second GET
 * of an enable flow, after the PATCH has already been sent.
 */
export function managementApiDouble(
  responses: (Response | (() => Response | Promise<Response>))[],
  options: ManagementApiDoubleOptions = {},
): ManagementApiDouble {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push({
      url: describeTarget(input),
      method: init?.method ?? 'GET',
      headers: normaliseHeaders(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    const next = responses[index];
    index += 1;
    if (next === undefined) {
      throw new Error(`unexpected Management API call #${String(index)}`);
    }

    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;

  const client = new ManagementClient({
    accessToken: options.accessToken ?? SENTINEL_TOKEN,
    // Injected, never configurable in production. Kept HTTPS so no test can normalise
    // a plaintext habit into the suite.
    baseUrl: 'https://api.supabase.test',
    fetchImpl,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });

  return {
    client,
    requests,
    patches: () => requests.filter((request) => request.method === 'PATCH'),
  };
}

/** A `fetch` that never resolves until its signal aborts, for timeout tests. */
export const hangingFetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal == null) {
      return;
    }
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', () => {
      reject(abortError());
    });
  });
}) as typeof fetch;

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function describeTarget(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function normaliseHeaders(headers: RequestInit['headers']): Record<string, string> {
  if (headers === undefined) {
    return {};
  }

  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);

  return Object.fromEntries(entries.map(([key, value]) => [key.toLowerCase(), String(value)]));
}
