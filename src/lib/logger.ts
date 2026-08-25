/**
 * Minimal logger.
 *
 * Deliberately tiny: no dependency, no spinners, no colour. Informational output goes
 * to stdout so it can be piped, warnings and errors go to stderr. Streams are
 * injectable so tests can assert on output without touching the real process.
 */

export type LogLevel = 'info' | 'success' | 'warning' | 'error';

export interface Logger {
  /** Neutral line of output, no symbol. */
  plain(message: string): void;
  /** Blank separator line. */
  blank(): void;
  info(message: string): void;
  success(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

export interface LoggerOptions {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

const SYMBOLS: Record<LogLevel, string> = {
  info: '-',
  success: '✓',
  warning: '!',
  error: '✗',
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;

  const write = (stream: NodeJS.WritableStream, message: string): void => {
    stream.write(`${message}\n`);
  };

  return {
    plain(message) {
      write(out, message);
    },
    blank() {
      write(out, '');
    },
    info(message) {
      write(out, `${SYMBOLS.info} ${message}`);
    },
    success(message) {
      write(out, `${SYMBOLS.success} ${message}`);
    },
    warning(message) {
      write(err, `${SYMBOLS.warning} ${message}`);
    },
    error(message) {
      write(err, `${SYMBOLS.error} ${message}`);
    },
  };
}

/** Shared logger used by the CLI commands. */
export const logger: Logger = createLogger();
