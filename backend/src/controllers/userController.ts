import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  GetCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { dynamodb, s3Client, TABLES, S3_BUCKET } from '../config/aws';
import { UpdateProfileInput } from '../validators/schemas';
import { logger } from '../config/logger';

/**
 * GET /api/user/profile
 * Hent brukerens profil
 */
export const getProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    const result = await dynamodb.send(
      new GetCommand({
        TableName: TABLES.USERS,
        Key: { id: userId },
      })
    );

    if (!result.Item) {
      res.status(404).json({ message: 'Bruker ikke funnet' });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password: _password, ...userWithoutPassword } = result.Item;
    res.json(userWithoutPassword);
  } catch (error) {
    logger.error('Get profile error:', error);
    res.status(500).json({ message: 'Kunne ikke hente profil' });
  }
};

/**
 * PUT /api/user/profile
 * Oppdater brukerens profil
 */
export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const updates = req.body as UpdateProfileInput;

    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLES.USERS,
        Key: { id: userId },
        UpdateExpression:
          'set firstName = :firstName, lastName = :lastName, bio = :bio, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':firstName': updates.firstName,
          ':lastName': updates.lastName,
          ':bio': updates.bio || '',
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      })
    );

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password: _password, ...userWithoutPassword } = result.Attributes || {};
    res.json(userWithoutPassword);
  } catch (error) {
    logger.error('Update profile error:', error);
    res.status(500).json({ message: 'Kunne ikke oppdatere profil' });
  }
};

/**
 * POST /api/user/profile-image
 * Last opp profilbilde til S3
 */
export const uploadProfileImage = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const file = req.file;

    if (!file) {
      res.status(400).json({ message: 'Ingen fil lastet opp' });
      return;
    }

    // Valider filtype
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      res.status(400).json({ message: 'Ugyldig filtype. Kun JPG, PNG og WebP er tillatt' });
      return;
    }

    // Valider filstørrelse (maks 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      res.status(400).json({ message: 'Filen er for stor. Maksimal størrelse er 5MB' });
      return;
    }

    // Generer unikt filnavn
    const fileExtension = file.originalname.split('.').pop();
    const fileName = `${userId}-${uuidv4()}.${fileExtension}`;
    const s3Key = `profile-images/${fileName}`;

    // Last opp til S3
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
    );

    // Generer URL (bruker region fra environment)
    const region = process.env.AWS_REGION || 'eu-north-1';
    const imageUrl = `https://${S3_BUCKET}.s3.${region}.amazonaws.com/${s3Key}`;

    // Oppdater brukerens profil med bilde-URL
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLES.USERS,
        Key: { id: userId },
        UpdateExpression: 'set profileImageUrl = :url, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':url': imageUrl,
          ':updatedAt': new Date().toISOString(),
        },
      })
    );

    logger.info(`✅ Profile image uploaded for user ${userId}`);
    res.json({ profileImageUrl: imageUrl });
  } catch (error) {
    logger.error('Upload profile image error:', error);
    res.status(500).json({ message: 'Kunne ikke laste opp bilde' });
  }
};

/**
 * GET /api/user/handicap-history
 * Hent handicap-historikk
 */
export const getHandicapHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    // Hent alle runder for bruker
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: TABLES.ROUNDS,
        IndexName: 'userId-date-index',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId,
        },
        ScanIndexForward: true, // Sortert etter dato
      })
    );

    // Beregn handicap-utvikling basert på runder
    // For hver runde, beregn hva handicappet var etter den runden
    const rounds = result.Items || [];
    const history: Array<{ date: string; handicap: number; scoreDifferential: number }> = [];

    // Sorter og prosesser rundene i kronologisk rekkefølge
    for (let i = 0; i < rounds.length; i++) {
      const currentRounds = rounds.slice(0, i + 1);

      // Beregn handicap basert på alle runder frem til denne
      let handicap = 54.0; // Default

      if (currentRounds.length >= 3) {
        const sortedDiffs = currentRounds.map(r => r.scoreDifferential).sort((a, b) => a - b);

        // Bruk WHS-regler for antall runder å telle
        let countToUse = 1;
        if (currentRounds.length >= 20) countToUse = 8;
        else if (currentRounds.length >= 6) countToUse = Math.floor(currentRounds.length * 0.4);
        else if (currentRounds.length >= 3) countToUse = 1;

        const bestDiffs = sortedDiffs.slice(0, countToUse);
        const avgDiff = bestDiffs.reduce((sum, diff) => sum + diff, 0) / bestDiffs.length;
        handicap = Math.max(0, Math.min(54, avgDiff * 0.96));
      }

      history.push({
        date: rounds[i].date,
        handicap: Math.round(handicap * 10) / 10, // Rund til 1 desimal
        scoreDifferential: rounds[i].scoreDifferential,
      });
    }

    res.json(history);
  } catch (error) {
    logger.error('Get handicap history error:', error);
    res.status(500).json({ message: 'Kunne ikke hente handicap-historikk' });
  }
};

/**
 * GET /api/users/search?q=query
 * Søk etter brukere (for å finne medspillere)
 */
export const searchUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    const query = ((req.query.q as string) || '').toLowerCase().trim();

    if (!query || query.length < 2) {
      res.status(400).json({ message: 'Søkeord må være minst 2 tegn' });
      return;
    }

    // Hent alle brukere (i produksjon bør dette optimaliseres med en søkeindeks)
    const result = await dynamodb.send(
      new ScanCommand({
        TableName: TABLES.USERS,
        ProjectionExpression: 'id, firstName, lastName, email, handicap, profileImageUrl',
      })
    );

    const users = result.Items || [];

    // Filtrer brukere basert på søkeord
    const filteredUsers = users.filter(user => {
      const fullName = `${user.firstName} ${user.lastName}`.toLowerCase();
      const email = user.email.toLowerCase();
      return fullName.includes(query) || email.includes(query);
    });

    // Sorter etter relevans (match i navn kommer først)
    const sortedUsers = filteredUsers.sort((a, b) => {
      const aName = `${a.firstName} ${a.lastName}`.toLowerCase();
      const bName = `${b.firstName} ${b.lastName}`.toLowerCase();
      const aStartsWith = aName.startsWith(query);
      const bStartsWith = bName.startsWith(query);
      if (aStartsWith && !bStartsWith) return -1;
      if (!aStartsWith && bStartsWith) return 1;
      return aName.localeCompare(bName);
    });

    // Begrens til 20 resultater
    const limitedResults = sortedUsers.slice(0, 20).map(user => ({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      handicap: user.handicap,
      profileImageUrl: user.profileImageUrl,
    }));

    res.json(limitedResults);
  } catch (error) {
    logger.error('Search users error:', error);
    res.status(500).json({ message: 'Kunne ikke søke etter brukere' });
  }
};

/**
 * POST /api/users/batch
 * Hent flere brukere basert på IDs (for å vise spillernavn i runder)
 */
export const batchGetUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userIds } = req.body as { userIds: string[] };

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      res.status(400).json({ message: 'userIds må være en ikke-tom array' });
      return;
    }

    // Limit to 100 users max to prevent abuse
    if (userIds.length > 100) {
      res.status(400).json({ message: 'Maksimalt 100 brukere kan hentes om gangen' });
      return;
    }

    // Batch get from DynamoDB
    const keys = userIds.map(id => ({ id }));

    const result = await dynamodb.send(
      new BatchGetCommand({
        RequestItems: {
          [TABLES.USERS]: {
            Keys: keys,
            ProjectionExpression: 'id, firstName, lastName, email, handicap, profileImageUrl',
          },
        },
      })
    );

    const users = result.Responses?.[TABLES.USERS] || [];

    // Return users in the same order as requested
    const usersMap = new Map(users.map(user => [user.id, user]));
    const orderedUsers = userIds
      .map(id => usersMap.get(id))
      .filter(user => user !== undefined)
      .map(user => ({
        id: user!.id,
        firstName: user!.firstName,
        lastName: user!.lastName,
        email: user!.email,
        handicap: user!.handicap,
        profileImageUrl: user!.profileImageUrl,
      }));

    res.json(orderedUsers);
  } catch (error) {
    logger.error('Batch get users error:', error);
    res.status(500).json({ message: 'Kunne ikke hente brukere' });
  }
};
