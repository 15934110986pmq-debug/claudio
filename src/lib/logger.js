const pino = require('pino');
const pinoPretty = require('pino-pretty');
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = path.join(LOG_DIR, 'claudio.log');
const logFileStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

// Build streams directly without transport workers (avoids thread cloning issues).
// In TTY → pretty print to stdout + JSON to file.
// Otherwise → JSON to stdout + file.
const streams = [];

if (process.stdout.isTTY) {
    streams.push({
        level: 'debug',
        stream: pinoPretty({
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname'
        })
    });
} else {
    streams.push({ level: 'info', stream: process.stdout });
}

// Always log JSON to file (append-only, no rotation yet).
streams.push({ level: 'info', stream: logFileStream });

const logger = pino(
    {
        level: process.env.LOG_LEVEL || 'info',
        base: { app: 'claudio' },
        timestamp: pino.stdTimeFunctions.isoTime
    },
    pino.multistream(streams)
);

// Optional Sentry integration — only loaded if DSN is set.
if (process.env.SENTRY_DSN) {
    try {
        const Sentry = require('@sentry/node');
        Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
        const origError = logger.error.bind(logger);
        logger.error = function (obj, msg, ...rest) {
            try {
                if (obj instanceof Error) Sentry.captureException(obj);
                else if (msg) Sentry.captureMessage(typeof msg === 'string' ? msg : JSON.stringify(msg));
            } catch {}
            return origError(obj, msg, ...rest);
        };
        logger.info('[logger] Sentry enabled');
    } catch (e) {
        logger.warn('[logger] SENTRY_DSN set but @sentry/node not installed — run `npm i @sentry/node`');
    }
}

module.exports = logger;
