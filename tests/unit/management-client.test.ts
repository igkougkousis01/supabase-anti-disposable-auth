import { describe, expect, it } from 'vitest';

import { EXIT_CODES, SupabaseApiError } from '../../src/lib/errors.js';
import { BEFORE_USER_CREATED_HOOK_URI } from '../../src/supabase/constants.js';
import { ManagementClient } from '../../src/supabase/management-client.js';
import {
  authConfigResponse,
  errorResponse,
  hangingFetch,
  managementApiDouble,
  ours,
  SENTINEL_TOKEN,
  TEST_PROJECT_REF,
  unconfigured,
} from '../helpers/management-api.js';

describe('ManagementClient.getAuthConfig', () => {
  it('reads the two fields it cares about', async () => {
    const api = managementApiDouble([authConfigResponse(ours(true))]);

    const document = await api.client.getAuthConfig(TEST_PROJECT_REF);

    expect(document.hook_before_user_created_enabled).toBe(true);
    expect(document.hook_before_user_created_uri).toBe(BEFORE_USER_CREATED_HOOK_URI);
  });

  it('requests the documented endpoint with the project ref as one path segment', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);

    await api.client.getAuthConfig(TEST_PROJECT_REF);

    expect(api.requests[0]?.url).toBe(
      `https://api.supabase.test/v1/projects/${TEST_PROJECT_REF}/config/auth`,
    );
    expect(api.requests[0]?.method).toBe('GET');
  });

  it('sends the token in the Authorization header, as a bearer token', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);

    await api.client.getAuthConfig(TEST_PROJECT_REF);

    expect(api.requests[0]?.headers['authorization']).toBe(`Bearer ${SENTINEL_TOKEN}`);
  });

  it('never puts the token in the URL', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);

    await api.client.getAuthConfig(TEST_PROJECT_REF);

    // The whole request line, not just the query string: a token in a path segment is
    // just as exposed to proxy logs and browser history as one in `?token=`.
    expect(api.requests[0]?.url).not.toContain(SENTINEL_TOKEN);
    expect(api.requests[0]?.url).not.toContain('token');
  });

  it('tolerates unrelated fields the API adds later', async () => {
    // The fixture is padded with SMTP, OAuth and hook-secret fields this tool does not
    // model. A schema that rejected them would break every hook command the next time
    // Supabase shipped an Auth setting.
    const api = managementApiDouble([authConfigResponse(ours(false))]);

    await expect(api.client.getAuthConfig(TEST_PROJECT_REF)).resolves.toBeDefined();
  });

  it('accepts null for both hook fields', async () => {
    const api = managementApiDouble([
      authConfigResponse({
        hook_before_user_created_enabled: null,
        hook_before_user_created_uri: null,
      }),
    ]);

    const document = await api.client.getAuthConfig(TEST_PROJECT_REF);

    expect(document.hook_before_user_created_enabled).toBeNull();
    expect(document.hook_before_user_created_uri).toBeNull();
  });

  it('accepts a document that omits the hook fields entirely', async () => {
    const api = managementApiDouble([
      new Response(JSON.stringify({ site_url: 'https://example.test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);

    await expect(api.client.getAuthConfig(TEST_PROJECT_REF)).resolves.toBeDefined();
  });
});

describe('ManagementClient.updateAuthConfig', () => {
  it('sends only the fields it was given', async () => {
    const api = managementApiDouble([authConfigResponse(ours(true))]);

    await api.client.updateAuthConfig(TEST_PROJECT_REF, {
      hook_before_user_created_enabled: true,
      hook_before_user_created_uri: BEFORE_USER_CREATED_HOOK_URI,
    });

    const request = api.requests[0];
    expect(request?.method).toBe('PATCH');
    expect(JSON.parse(request?.body ?? '{}')).toEqual({
      hook_before_user_created_enabled: true,
      hook_before_user_created_uri: BEFORE_USER_CREATED_HOOK_URI,
    });
  });

  it('declares a JSON content type only when it has a body', async () => {
    const api = managementApiDouble([
      authConfigResponse(unconfigured()),
      authConfigResponse(ours(false)),
    ]);

    await api.client.getAuthConfig(TEST_PROJECT_REF);
    await api.client.updateAuthConfig(TEST_PROJECT_REF, {
      hook_before_user_created_enabled: false,
    });

    expect(api.requests[0]?.headers['content-type']).toBeUndefined();
    expect(api.requests[1]?.headers['content-type']).toBe('application/json');
  });
});

describe('ManagementClient error statuses', () => {
  const cases: [number, RegExp][] = [
    [401, /rejected the Management API access token/i],
    [403, /not permitted/i],
    [404, /does not recognise this project ref/i],
    [429, /rate-limited/i],
    [500, /unavailable/i],
    [503, /unavailable/i],
  ];

  it.each(cases)('maps HTTP %i to an actionable message', async (status, pattern) => {
    const api = managementApiDouble([errorResponse(status)]);

    await expect(api.client.getAuthConfig(TEST_PROJECT_REF)).rejects.toThrow(pattern);
  });

  it.each(cases)('exits with the remote code for HTTP %i', async (status) => {
    const api = managementApiDouble([errorResponse(status)]);

    await expect(api.client.getAuthConfig(TEST_PROJECT_REF)).rejects.toMatchObject({
      exitCode: EXIT_CODES.remote,
      kind: 'remote',
    });
  });

  it('surfaces the server message in the hint, sanitised', async () => {
    // The real message a Free/Pro project gets when it PATCHes a hook field. It is
    // exactly what an operator needs to see, so it is shown -- but as untrusted text.
    const api = managementApiDouble([
      errorResponse(403, 'Auth Hooks can only be configured on Team or Enterprise Plans.'),
    ]);

    await expect(api.client.getAuthConfig(TEST_PROJECT_REF)).rejects.toMatchObject({
      hint: expect.stringContaining('Team or Enterprise Plans') as unknown,
    });
  });

  it('strips terminal escape sequences from a server message', async () => {
    // Remote text is never allowed to drive an operator's console.
    const hostile = '\u001b[2J\u0007wiped';
    const api = managementApiDouble([errorResponse(400, hostile)]);

    const error = await api.client.getAuthConfig(TEST_PROJECT_REF).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SupabaseApiError);
    expect((error as SupabaseApiError).hint).not.toContain('\u001b');
    expect((error as SupabaseApiError).hint).not.toContain('\u0007');
    expect((error as SupabaseApiError).hint).toContain('wiped');
  });
  it('truncates an oversized server message', async () => {
    const api = managementApiDouble([errorResponse(400, 'x'.repeat(10_000))]);

    const error = await api.client.getAuthConfig(TEST_PROJECT_REF).catch((cause: unknown) => cause);

    expect((error as SupabaseApiError).hint?.length ?? 0).toBeLessThan(500);
  });

  it('ignores an error body that is not JSON', async () => {
    const api = managementApiDouble([
      new Response('<html>gateway error</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    ]);

    const error = await api.client.getAuthConfig(TEST_PROJECT_REF).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SupabaseApiError);
    expect((error as SupabaseApiError).hint).not.toContain('<html>');
  });
});

describe('ManagementClient response validation', () => {
  it('rejects a body that is not valid JSON', async () => {
    const api = managementApiDouble([
      new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]);

    await expect(api.client.getAuthConfig(TEST_PROJECT_REF)).rejects.toThrow(/not valid JSON/i);
  });

  it('rejects a body whose hook fields are the wrong type', async () => {
    const api = managementApiDouble([
      authConfigResponse({ hook_before_user_created_enabled: 'yes' as unknown as boolean }),
    ]);

    await expect(api.client.getAuthConfig(TEST_PROJECT_REF)).rejects.toThrow(
      /does not understand/i,
    );
  });

  it('names the offending field but never a value', async () => {
    const api = managementApiDouble([
      authConfigResponse({ hook_before_user_created_uri: 42 as unknown as string }),
    ]);

    const error = await api.client.getAuthConfig(TEST_PROJECT_REF).catch((cause: unknown) => cause);

    expect((error as SupabaseApiError).message).toContain('hook_before_user_created_uri');
    // The document holds SMTP and OAuth secrets. A validation failure must not print it.
    expect((error as SupabaseApiError).message).not.toContain('UNRELATED_SMTP_PASSWORD');
    expect((error as SupabaseApiError).message).not.toContain('UNRELATED_OAUTH_SECRET');
  });

  it('rejects a non-JSON content type on a 200', async () => {
    // A captive portal or proxy answering with an HTML page is the realistic case.
    const api = managementApiDouble([
      new Response('<html>sign in to the wifi</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ]);

    await expect(api.client.getAuthConfig(TEST_PROJECT_REF)).rejects.toThrow(/non-JSON/i);
  });

  it('rejects a 200 that declares no content type', async () => {
    const api = managementApiDouble([new Response('{}', { status: 200 })]);

    await expect(api.client.getAuthConfig(TEST_PROJECT_REF)).rejects.toThrow(/non-JSON/i);
  });
});

describe('ManagementClient transport safety', () => {
  it('times out rather than hanging', async () => {
    const client = new ManagementClient({
      accessToken: SENTINEL_TOKEN,
      baseUrl: 'https://api.supabase.test',
      fetchImpl: hangingFetch,
      timeoutMs: 10,
    });

    await expect(client.getAuthConfig(TEST_PROJECT_REF)).rejects.toThrow(/Timed out/i);
  });

  it('reports a caller-initiated abort as a cancellation, not a timeout', async () => {
    const controller = new AbortController();
    const client = new ManagementClient({
      accessToken: SENTINEL_TOKEN,
      baseUrl: 'https://api.supabase.test',
      fetchImpl: hangingFetch,
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    const pending = client.getAuthConfig(TEST_PROJECT_REF);
    controller.abort();

    await expect(pending).rejects.toThrow(/cancelled/i);
  });

  it('reports an unreachable host without naming a URL', async () => {
    const api = managementApiDouble([
      () => {
        throw new Error('getaddrinfo ENOTFOUND api.supabase.test');
      },
    ]);

    const error = await api.client.getAuthConfig(TEST_PROJECT_REF).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SupabaseApiError);
    expect((error as SupabaseApiError).message).toMatch(/Could not reach/i);
  });

  it('refuses an oversized response that declares its size honestly', async () => {
    const api = managementApiDouble(
      [
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': '99999' },
        }),
      ],
      { maxBytes: 64 },
    );

    await expect(api.client.getAuthConfig(TEST_PROJECT_REF)).rejects.toThrow(/too large/i);
  });

  it('refuses an oversized response that lies about its size', async () => {
    // content-length is a claim, not a fact. The ceiling is applied while streaming.
    const api = managementApiDouble(
      [
        new Response(JSON.stringify({ padding: 'x'.repeat(4096) }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': '2' },
        }),
      ],
      { maxBytes: 64 },
    );

    await expect(api.client.getAuthConfig(TEST_PROJECT_REF)).rejects.toThrow(/too large/i);
  });

  it('never follows a redirect on an authenticated request', async () => {
    // Following one would carry the Authorization header to whatever host the Location
    // header names, which is the classic token-exfiltration path.
    const api = managementApiDouble([
      new Response(null, { status: 302, headers: { location: 'https://evil.test/collect' } }),
    ]);

    await expect(api.client.getAuthConfig(TEST_PROJECT_REF)).rejects.toThrow(/redirected/i);
    expect(api.requests).toHaveLength(1);
  });

  it('refuses a non-HTTPS base URL', () => {
    expect(
      () =>
        new ManagementClient({ accessToken: SENTINEL_TOKEN, baseUrl: 'http://api.supabase.test' }),
    ).toThrow(/Refusing to send Management API credentials over http/i);
  });

  it('does not retry automatically', async () => {
    // One queued response and a 500: a retrying client would ask for a second and the
    // double would throw "unexpected call #2".
    const api = managementApiDouble([errorResponse(500)]);

    await expect(api.client.getAuthConfig(TEST_PROJECT_REF)).rejects.toThrow();
    expect(api.requests).toHaveLength(1);
  });
});

describe('ManagementClient project ref handling', () => {
  it.each([
    'short',
    'abcdefghijklmnopqrs/',
    '../../v1/projects/other/config/auth',
    'ABCDEFGHIJKLMNOPQRST',
    'abcdefghijklmnopqrst extra',
    '',
  ])('refuses %j before sending anything', async (ref) => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);

    await expect(api.client.getAuthConfig(ref)).rejects.toThrow(/not in a valid format/i);
    // The point of validating early: no request was made, so no token went anywhere.
    expect(api.requests).toHaveLength(0);
  });

  it('accepts a ref containing digits', async () => {
    // Narrower than reality would lock out a legitimate project: the OpenAPI pattern
    // says letters only, but real refs may carry digits.
    const api = managementApiDouble([authConfigResponse(unconfigured())]);

    await expect(api.client.getAuthConfig('abcdefghijklmnop1234')).resolves.toBeDefined();
  });
});
