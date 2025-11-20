import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../config/logger';

/**
 * Interface for JWT payload
 */
export interface JwtPayload {
  userId: string;
  email: string;
}

/**
 * Utvid Express Request med user-property
 */
declare module 'express-serve-static-core' {
  interface Request {
    user?: JwtPayload;
  }
}

/**
 * Middleware for å autentisere JWT token
 * Legger til user-objekt på request hvis token er gyldig
 */
export const authenticate = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ message: 'Ingen token funnet' });
      return;
    }

    const token = authHeader.substring(7);

    const secret = process.env.JWT_SECRET;

    if (!secret) {
      logger.error('❌ JWT_SECRET not set!');
      throw new Error('JWT_SECRET er ikke satt');
    }

    const decoded = jwt.verify(token, secret) as JwtPayload;
    req.user = decoded;
    next();
  } catch (error) {
    logger.error('❌ Token verification failed:', error);
    res.status(401).json({ message: 'Ugyldig eller utløpt token' });
  }
};
