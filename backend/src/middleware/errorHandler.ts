import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';

/**
 * Custom error class
 */
export class AppError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Global error handler middleware
 */
export const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const statusCode = (err as AppError).statusCode || 500;
  const message = err.message || 'Intern serverfeil';

  // Logg feil i produksjon
  if (process.env.NODE_ENV === 'production') {
    logger.error('API Error:', {
      message: err.message,
      stack: err.stack,
      url: req.url,
      method: req.method,
    });
  } else {
    // Vis full stack trace i development
    logger.error('Development Error:', err);
  }

  res.status(statusCode).json({
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};
