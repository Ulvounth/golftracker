import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLES } from '../config/aws';
import { hashPassword, comparePassword } from '../utils/password';
import { generateToken } from '../utils/jwt';
import { RegisterInput, LoginInput } from '../validators/schemas';
import { logger } from '../config/logger';

/**
 * POST /api/auth/register
 * Registrer ny bruker
 */
export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, firstName, lastName } = req.body as RegisterInput;

    // Sjekk om bruker finnes fra før
    const existingUser = await dynamodb.send(
      new QueryCommand({
        TableName: TABLES.USERS,
        IndexName: 'email-index',
        KeyConditionExpression: 'email = :email',
        ExpressionAttributeValues: {
          ':email': email,
        },
      })
    );

    if (existingUser.Items && existingUser.Items.length > 0) {
      res.status(400).json({ message: 'E-postadressen er allerede registrert' });
      return;
    }

    // Hash passord
    const hashedPassword = await hashPassword(password);

    // Opprett bruker
    const userId = uuidv4();
    const timestamp = new Date().toISOString();

    const user = {
      id: userId,
      email,
      password: hashedPassword,
      firstName,
      lastName,
      handicap: 54.0, // Start-handicap
      bio: '',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await dynamodb.send(
      new PutCommand({
        TableName: TABLES.USERS,
        Item: user,
      })
    );

    // Generer JWT token
    const token = generateToken({ userId, email });

    // Returner brukerdata uten passord
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password: _password, ...userWithoutPassword } = user;

    res.status(201).json({
      user: userWithoutPassword,
      token,
    });
  } catch (error) {
    logger.error('Register error:', error);
    res.status(500).json({ message: 'Kunne ikke registrere bruker' });
  }
};

/**
 * POST /api/auth/login
 * Logg inn bruker
 */
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body as LoginInput;

    // Finn bruker
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: TABLES.USERS,
        IndexName: 'email-index',
        KeyConditionExpression: 'email = :email',
        ExpressionAttributeValues: {
          ':email': email,
        },
      })
    );

    if (!result.Items || result.Items.length === 0) {
      res.status(401).json({ message: 'Ugyldig e-post eller passord' });
      return;
    }

    const user = result.Items[0];

    // Verifiser passord
    const isValidPassword = await comparePassword(password, user.password);

    if (!isValidPassword) {
      res.status(401).json({ message: 'Ugyldig e-post eller passord' });
      return;
    }

    // Generer JWT token
    const token = generateToken({ userId: user.id, email: user.email });

    // Returner brukerdata uten passord
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password: _password, ...userWithoutPassword } = user;

    res.json({
      user: userWithoutPassword,
      token,
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ message: 'Kunne ikke logge inn' });
  }
};

/**
 * GET /api/auth/verify
 * Verifiser JWT token
 */
export const verifyToken = async (req: Request, res: Response): Promise<void> => {
  res.json({ message: 'Token er gyldig', userId: req.user?.userId });
};
