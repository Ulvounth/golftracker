import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/authRoutes';
import userRoutes from './routes/userRoutes';
import roundRoutes from './routes/roundRoutes';
import courseRoutes from './routes/courseRoutes';
import leaderboardRoutes from './routes/leaderboardRoutes';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './config/logger';
import { validateEnvironment, getEnvironmentInfo } from './utils/validateEnv';

// Last inn miljøvariabler
dotenv.config();

// Validate environment before starting
try {
  validateEnvironment();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
} catch (_error) {
  process.exit(1);
}

const app: Express = express();
const PORT = process.env.PORT || 3001;

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware
app.use(helmet()); // Sikkerhet
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3000' })); // CORS
app.use(express.json()); // Parse JSON
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded data
app.use('/api/', limiter); // Rate limiting for all API routes

// Ruter
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/rounds', roundRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/leaderboard', leaderboardRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handler (må være sist)
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  logger.info(`🚀 Server kjører på port ${PORT}`);
  const envInfo = getEnvironmentInfo();
  Object.entries(envInfo).forEach(([key, value]) => {
    logger.info(`  ${key}: ${value}`);
  });
  logger.info('✅ Server ready to accept connections');
});

export default app;
