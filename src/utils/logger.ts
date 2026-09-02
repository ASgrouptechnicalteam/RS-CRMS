import pino from 'pino';

const pinoLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const logger = {
  info: (...args: any[]) => {
    if (args.length === 2 && typeof args[0] === 'string') {
      pinoLogger.info({ data: args[1] }, args[0]);
    } else {
      pinoLogger.info(args.length === 1 ? args[0] : args);
    }
  },
  error: (...args: any[]) => {
    if (args.length === 2 && typeof args[0] === 'string') {
      pinoLogger.error({ err: args[1] }, args[0]);
    } else {
      pinoLogger.error(args.length === 1 ? args[0] : args);
    }
  },
  warn: (...args: any[]) => {
    if (args.length === 2 && typeof args[0] === 'string') {
      pinoLogger.warn({ data: args[1] }, args[0]);
    } else {
      pinoLogger.warn(args.length === 1 ? args[0] : args);
    }
  }
};
