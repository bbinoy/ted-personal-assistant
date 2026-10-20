/**
 * Where the package reports what it would otherwise print. A library should not write to the host's console on
 * its own, so the default is silent; pass `console` (or your own logger) to see messages.
 */
export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const noop = () => {};
/** A logger that drops everything (the default). */
export const silentLogger: Logger = { info: noop, warn: noop, error: noop };
