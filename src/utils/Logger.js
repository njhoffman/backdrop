import winston from 'winston';
import path from 'path';

export class Logger {
  constructor(logPath = null) {
    this.logPath = logPath || path.join(process.cwd(), 'backdrop.log');
    this.logger = this.createLogger();
  }

  // Off by default so CLI commands print their own messages; the foreground daemon turns it on
  enableConsole(level = 'info') {
    this.logger.add(new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
      level
    }));
  }

  createLogger() {
    return winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({ 
          filename: this.logPath,
          maxsize: 5242880, // 5MB
          maxFiles: 5
        })
      ]
    });
  }

  info(message, meta = {}) {
    this.logger.info(message, meta);
  }

  error(message, meta = {}) {
    this.logger.error(message, meta);
  }

  warn(message, meta = {}) {
    this.logger.warn(message, meta);
  }

  debug(message, meta = {}) {
    this.logger.debug(message, meta);
  }
}