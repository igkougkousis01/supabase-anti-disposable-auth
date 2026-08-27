import { Writable } from 'node:stream';

import { beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/lib/logger.js';
import type { Logger } from '../../src/lib/logger.js';

function createCapturingStream(sink: string[]): NodeJS.WritableStream {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      sink.push(chunk.toString());
      callback();
    },
  });
}

describe('createLogger', () => {
  let stdout: string[];
  let stderr: string[];
  let logger: Logger;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    logger = createLogger({
      stdout: createCapturingStream(stdout),
      stderr: createCapturingStream(stderr),
    });
  });

  it('writes informational output to stdout', () => {
    logger.plain('title');
    logger.info('working');
    logger.success('done');

    expect(stdout).toEqual(['title\n', '- working\n', '✓ done\n']);
    expect(stderr).toEqual([]);
  });

  it('writes error details to stderr, with no symbol', () => {
    // A hint belongs on the same stream as the error it explains.
    logger.detail('Set SUPABASE_DB_URL and try again.');

    expect(stderr).toEqual(['Set SUPABASE_DB_URL and try again.\n']);
    expect(stdout).toEqual([]);
  });

  it('writes warnings and errors to stderr', () => {
    logger.warning('careful');
    logger.error('failed');

    expect(stderr).toEqual(['! careful\n', '✗ failed\n']);
    expect(stdout).toEqual([]);
  });

  it('writes a blank separator line', () => {
    logger.blank();
    expect(stdout).toEqual(['\n']);
  });
});
