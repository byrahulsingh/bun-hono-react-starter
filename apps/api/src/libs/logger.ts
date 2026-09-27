/**
 * Structured logging. Every subsystem logs through here.
 *
 *   logger.auth.info({ userId }, 'signed in');
 *   logger.db.error({ err }, 'migration failed');
 *
 * Subsystems are a fixed list, so a typo (`logger.atuh`) is a compile error and
 * every log line carries a `name` you can filter on. To add one, add it to
 * SUBSYSTEMS — that is the only change needed.
 *
 * Configured from the validated `env`, so level and format are decided in one
 * place and this module never touches `process.env`.
 */

import type { Logger, LoggerOptions } from 'pino';
import pino from 'pino';

import { env, isProd } from '#/libs/env';

const SUBSYSTEMS = ['server', 'http', 'db', 'auth'] as const;

export type Subsystem = (typeof SUBSYSTEMS)[number];

const devTransport: LoggerOptions['transport'] = {
  target: 'pino-pretty',
  options: {
    colorize: true,
    translateTime: 'SYS:HH:MM:ss',
    ignore: 'pid,hostname',
  },
};

/**
 * The root logger. Use a subsystem logger instead; this is exported for
 * per-request children (see app.ts), which belong to a request, not a subsystem.
 */
export const rootLogger = pino({
  level: env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  // JSON in production so log aggregators can parse it; pretty in dev.
  transport: isProd ? undefined : devTransport,
  // API keys, tokens and passwords must never reach a log line, even when a
  // whole config object is logged by mistake.
  redact: {
    paths: [
      'password',
      '*.password',
      'token',
      '*.token',
      'apiKey',
      '*.apiKey',
      'secret',
      '*.secret',
      'headers.authorization',
      '*.headers.authorization',
    ],
    censor: '[redacted]',
  },
});

export const logger = Object.fromEntries(
  SUBSYSTEMS.map((name) => [name, rootLogger.child({ name })]),
) as Record<Subsystem, Logger>;

export type { Logger, LoggerOptions };
