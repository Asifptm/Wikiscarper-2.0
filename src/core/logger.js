const fs = require('fs');
const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');
const { resolvePath } = require('../shared/config');

function createLogger(config = {}) {
  const logDir = resolvePath(config.dir ?? './logs');
  fs.mkdirSync(logDir, { recursive: true });

  return winston.createLogger({
    level: process.env.LOG_LEVEL ?? config.level ?? 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        ),
      }),
      new winston.transports.DailyRotateFile({
        filename: path.join(logDir, 'scraper-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxFiles: '14d',
        maxSize: '50m',
      }),
    ],
  });
}

module.exports = createLogger;
