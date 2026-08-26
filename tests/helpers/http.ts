/**
 * `fetch` doubles.
 *
 * No unit test in this repository is allowed to touch the network, so every provider
 * and fetch test drives one of these instead of the global `fetch`.
 */

export interface FakeResponseOptions {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** A plain successful `text/plain` response. */
export function textResponse(body: string, options: FakeResponseOptions = {}): Response {
  const bytes = new TextEncoder().encode(body);

  return new Response(bytes, {
    status: options.status ?? 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(bytes.byteLength),
      ...options.headers,
    },
  });
}

/** A response with no body, used for redirects and error statuses. */
export function bareResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/**
 * A response whose declared `content-length` lies about how much it will send.
 *
 * This is the case the streaming byte ceiling exists for: an upstream cannot be
 * trusted to declare its own size honestly.
 */
export function lyingLengthResponse(body: string, declaredLength: number): Response {
  const bytes = new TextEncoder().encode(body);

  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'text/plain',
      'content-length': String(declaredLength),
    },
  });
}

export interface FetchRecorder {
  readonly fetchImpl: typeof fetch;
  /** Every URL requested, in order. */
  readonly urls: string[];
  readonly init: RequestInit[];
}

/** Returns queued responses in order, recording what was asked for. */
export function recordingFetch(responses: (Response | (() => Response | never))[]): FetchRecorder {
  const urls: string[] = [];
  const init: RequestInit[] = [];
  let index = 0;

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    urls.push(describeTarget(input));
    init.push(options ?? {});

    const next = responses[index];
    index += 1;
    if (next === undefined) {
      throw new Error(`unexpected fetch call #${index}`);
    }

    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;

  return { fetchImpl, urls, init };
}

/** A `fetch` that never resolves until its signal aborts, for timeout tests. */
export const hangingFetch = (async (_input: Parameters<typeof fetch>[0], options?: RequestInit) => {
  return new Promise<Response>((_resolve, reject) => {
    const signal = options?.signal;
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

function describeTarget(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}
