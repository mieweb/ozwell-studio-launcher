/** Shared pino logger, used by Fastify and the manager API client alike. */
import pino from 'pino';
import { config } from './config.js';

export const logger = pino({ level: config.logLevel });
