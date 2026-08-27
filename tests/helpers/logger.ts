/** Logger double that records every line, so tests can assert on CLI output. */

import type { Logger } from '../../src/lib/logger.js';

export interface RecordingLogger {
  readonly logger: Logger;
  /** Every line written, in order, without level symbols. */
  readonly lines: string[];
  /** All output joined with newlines. Bound, so it is safe to destructure. */
  readonly output: () => string;
}

export function createRecordingLogger(): RecordingLogger {
  const lines: string[] = [];
  const record = (message: string): void => {
    lines.push(message);
  };

  const logger: Logger = {
    plain: record,
    blank: () => {
      lines.push('');
    },
    info: record,
    success: record,
    pending: record,
    detail: record,
    warning: record,
    error: record,
  };

  return { logger, lines, output: () => lines.join('\n') };
}
