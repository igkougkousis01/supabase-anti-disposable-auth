import { describe, expect, it } from 'vitest';

import { fetchText } from '../../src/blocklist/fetch.js';
import { disposableEmailDomainsProvider } from '../../src/blocklist/providers/disposable-email-domains.js';
import { getProvider, DEFAULT_PROVIDER_NAME } from '../../src/blocklist/provider.js';
import { BlocklistFetchError, SyncError } from '../../src/lib/errors.js';
import {
  bareResponse,
  hangingFetch,
  lyingLengthResponse,
  recordingFetch,
  textResponse,
} from '../helpers/http.js';

const URL = 'https://example.test/domains.txt';
const ACCEPTED = ['text/plain'];

describe('fetchText', () => {
  it('downloads a plain-text body', async () => {
    const { fetchImpl, urls, init } = recordingFetch([textResponse('a.example\nb.example\n')]);

    const result = await fetchText({ url: URL, acceptedContentTypes: ACCEPTED, fetchImpl });

    expect(result.status).toBe(200);
    expect(result.body).toBe('a.example\nb.example\n');
    expect(result.bytes).toBe(20);
    expect(urls).toEqual([URL]);
    // Redirects are never delegated to the runtime.
    expect(init[0]?.redirect).toBe('manual');
  });

  it('refuses a non-HTTPS URL before sending anything', async () => {
    const { fetchImpl, urls } = recordingFetch([]);

    await expect(
      fetchText({
        url: 'http://example.test/domains.txt',
        acceptedContentTypes: ACCEPTED,
        fetchImpl,
      }),
    ).rejects.toThrow(BlocklistFetchError);
    expect(urls).toEqual([]);
  });

  it('refuses a URL that is not a URL', async () => {
    await expect(fetchText({ url: 'not a url', acceptedContentTypes: ACCEPTED })).rejects.toThrow(
      BlocklistFetchError,
    );
  });

  it('follows an HTTPS redirect', async () => {
    const { fetchImpl, urls } = recordingFetch([
      bareResponse(302, { location: 'https://cdn.example.test/domains.txt' }),
      textResponse('a.example\n'),
    ]);

    const result = await fetchText({ url: URL, acceptedContentTypes: ACCEPTED, fetchImpl });

    expect(result.url).toBe('https://cdn.example.test/domains.txt');
    expect(urls).toEqual([URL, 'https://cdn.example.test/domains.txt']);
  });

  it('refuses a redirect that downgrades to HTTP', async () => {
    const { fetchImpl, urls } = recordingFetch([
      bareResponse(302, { location: 'http://cdn.example.test/domains.txt' }),
    ]);

    await expect(
      fetchText({ url: URL, acceptedContentTypes: ACCEPTED, fetchImpl }),
    ).rejects.toThrow(/Refusing to follow a redirect/);
    // The insecure target is never requested.
    expect(urls).toEqual([URL]);
  });

  it('refuses a redirect without a target', async () => {
    const { fetchImpl } = recordingFetch([bareResponse(302)]);

    await expect(
      fetchText({ url: URL, acceptedContentTypes: ACCEPTED, fetchImpl }),
    ).rejects.toThrow(/without a target/);
  });

  it('stops after the redirect limit', async () => {
    const { fetchImpl } = recordingFetch(
      Array.from({ length: 5 }, () => bareResponse(302, { location: URL })),
    );

    await expect(
      fetchText({ url: URL, acceptedContentTypes: ACCEPTED, fetchImpl, maxRedirects: 2 }),
    ).rejects.toThrow(/Too many redirects/);
  });

  it('rejects a 404', async () => {
    const { fetchImpl } = recordingFetch([bareResponse(404)]);

    await expect(
      fetchText({ url: URL, acceptedContentTypes: ACCEPTED, fetchImpl }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('rejects a 500', async () => {
    const { fetchImpl } = recordingFetch([bareResponse(500)]);

    await expect(
      fetchText({ url: URL, acceptedContentTypes: ACCEPTED, fetchImpl }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('rejects an HTML error page served with HTTP 200', async () => {
    const { fetchImpl } = recordingFetch([
      textResponse('<html>not found</html>', { headers: { 'content-type': 'text/html' } }),
    ]);

    await expect(
      fetchText({ url: URL, acceptedContentTypes: ACCEPTED, fetchImpl }),
    ).rejects.toThrow(/returned "text\/html"/);
  });

  it('rejects a response with no content type', async () => {
    const { fetchImpl } = recordingFetch([
      new Response(new TextEncoder().encode('a.example\n'), { status: 200 }),
    ]);

    await expect(
      fetchText({ url: URL, acceptedContentTypes: ACCEPTED, fetchImpl }),
    ).rejects.toThrow(/declared no content type/);
  });

  it('ignores content-type parameters when matching', async () => {
    const { fetchImpl } = recordingFetch([
      textResponse('a.example\n', { headers: { 'content-type': 'TEXT/PLAIN; charset=UTF-8' } }),
    ]);

    await expect(
      fetchText({ url: URL, acceptedContentTypes: ACCEPTED, fetchImpl }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('rejects an honestly-declared oversized body before reading it', async () => {
    const { fetchImpl } = recordingFetch([
      textResponse('a.example\n', { headers: { 'content-length': '99999999' } }),
    ]);

    await expect(
      fetchText({ url: URL, acceptedContentTypes: ACCEPTED, fetchImpl, maxBytes: 1024 }),
    ).rejects.toThrow(/too large/);
  });

  it('rejects a body that exceeds the ceiling while streaming, whatever it declared', async () => {
    const { fetchImpl } = recordingFetch([lyingLengthResponse('x'.repeat(5000), 10)]);

    await expect(
      fetchText({ url: URL, acceptedContentTypes: ACCEPTED, fetchImpl, maxBytes: 1024 }),
    ).rejects.toThrow(/too large/);
  });

  it('times out', async () => {
    await expect(
      fetchText({
        url: URL,
        acceptedContentTypes: ACCEPTED,
        fetchImpl: hangingFetch,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/Timed out/);
  });

  it('honours a caller abort, and does not report it as a timeout', async () => {
    const controller = new AbortController();
    const promise = fetchText({
      url: URL,
      acceptedContentTypes: ACCEPTED,
      fetchImpl: hangingFetch,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow(/was cancelled/);
  });

  it('reports a transport failure without leaking internals', async () => {
    const { fetchImpl } = recordingFetch([
      () => {
        throw new Error('ECONNREFUSED');
      },
    ]);

    await expect(
      fetchText({ url: URL, acceptedContentTypes: ACCEPTED, fetchImpl }),
    ).rejects.toThrow(/Could not reach/);
  });

  it('sends an identifying user agent and no credentials', async () => {
    const { fetchImpl, init } = recordingFetch([textResponse('a.example\n')]);
    await fetchText({ url: URL, acceptedContentTypes: ACCEPTED, fetchImpl });

    const headers = init[0]?.headers as Record<string, string>;
    expect(headers['user-agent']).toContain('supabase-anti-disposable-auth');
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('authorization');
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('cookie');
  });
});

describe('disposableEmailDomainsProvider', () => {
  it('exposes a name, a source and an HTTPS raw-data URL', () => {
    expect(disposableEmailDomainsProvider.name).toBe('disposable-email-domains');
    expect(disposableEmailDomainsProvider.source).toBe('disposable-email-domains');
    expect(disposableEmailDomainsProvider.url).toMatch(/^https:\/\//);
    // A raw data endpoint, never a rendered GitHub page.
    expect(disposableEmailDomainsProvider.url).toContain('raw.githubusercontent.com');
    expect(disposableEmailDomainsProvider.upstream).toContain('disposable-email-domains');
  });

  it('returns the payload with the metadata the pipeline reports', async () => {
    const { fetchImpl } = recordingFetch([textResponse('a.example\nb.example\n')]);

    const raw = await disposableEmailDomainsProvider.fetch({ fetchImpl });

    expect(raw.body).toBe('a.example\nb.example\n');
    expect(raw.status).toBe(200);
    expect(raw.source).toBe('disposable-email-domains');
    expect(raw.bytes).toBeGreaterThan(0);
  });
});

describe('getProvider', () => {
  it('defaults to the only production provider', () => {
    expect(getProvider().name).toBe(DEFAULT_PROVIDER_NAME);
  });

  it('rejects an unknown provider by name', () => {
    expect(() => getProvider('does-not-exist')).toThrow(SyncError);
  });

  it('offers no way to supply an arbitrary URL', () => {
    // Deliberate: a caller-supplied URL would make this CLI an SSRF primitive running
    // with database credentials in its environment.
    expect(Object.keys(getProvider())).not.toContain('setUrl');
  });
});
