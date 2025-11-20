import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLES } from '../config/aws';
import { CreateRoundInput, CreateMultiPlayerRoundInput } from '../validators/schemas';
import { logger } from '../config/logger';

/**
 * Beregn score differential for handicap-beregning
 * Følger WHS (World Handicap System) regler
 *
 * For 9-hulls runder:
 * - courseRating må være 9-hulls rating (dvs. 18-hulls rating / 2)
 * - Score og rating blir doblet for å simulere 18-hull
 * - Bruker full 18-hulls slope (ikke halveres)
 *
 * Exported for testing
 */
export const calculateScoreDifferential = (
  totalScore: number,
  courseRating: number,
  slopeRating: number,
  numberOfHoles: number = 18
): number => {
  // For 9-hulls: doble både score og rating
  // OBS: courseRating skal være 9-hulls rating som input
  const adjustedScore = numberOfHoles === 9 ? totalScore * 2 : totalScore;
  const adjustedRating = numberOfHoles === 9 ? courseRating * 2 : courseRating;

  return ((adjustedScore - adjustedRating) * 113) / slopeRating;
};

/**
 * Beregn og oppdater brukerens handicap basert på WHS (World Handicap System)
 * Handicap = gjennomsnitt av de 8 beste score differentials av de siste 20 rundene
 */
const updateUserHandicap = async (userId: string): Promise<void> => {
  try {
    // Hent brukerens siste 20 runder
    const roundsResult = await dynamodb.send(
      new QueryCommand({
        TableName: TABLES.ROUNDS,
        IndexName: 'userId-date-index',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId,
        },
        ScanIndexForward: false, // Nyeste først
        Limit: 20,
      })
    );

    const rounds = roundsResult.Items || [];

    if (rounds.length === 0) {
      // Ingen runder, sett handicap til 54 (maks)
      await dynamodb.send(
        new UpdateCommand({
          TableName: TABLES.USERS,
          Key: { id: userId },
          UpdateExpression: 'set handicap = :handicap, updatedAt = :updatedAt',
          ExpressionAttributeValues: {
            ':handicap': 54.0,
            ':updatedAt': new Date().toISOString(),
          },
        })
      );
      return;
    }

    // Sorter etter score differential (beste først)
    const sortedDifferentials = rounds.map(r => r.scoreDifferential).sort((a, b) => a - b);

    // WHS regel: Bruk antall runder for å bestemme hvor mange som teller
    let numberOfScoresToUse = 1;
    if (rounds.length >= 20) {
      numberOfScoresToUse = 8;
    } else if (rounds.length >= 19) {
      numberOfScoresToUse = 7;
    } else if (rounds.length >= 16) {
      numberOfScoresToUse = 6;
    } else if (rounds.length >= 12) {
      numberOfScoresToUse = 5;
    } else if (rounds.length >= 9) {
      numberOfScoresToUse = 4;
    } else if (rounds.length >= 6) {
      numberOfScoresToUse = 3;
    } else if (rounds.length >= 3) {
      numberOfScoresToUse = 2;
    }

    // Ta de beste differentialene
    const bestDifferentials = sortedDifferentials.slice(0, numberOfScoresToUse);
    const averageDifferential =
      bestDifferentials.reduce((sum, diff) => sum + diff, 0) / bestDifferentials.length;

    // Handicap Index = gjennomsnitt av beste differentials (avrundet til 1 desimal)
    const newHandicap = Math.round(averageDifferential * 10) / 10;

    // Oppdater brukerens handicap
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLES.USERS,
        Key: { id: userId },
        UpdateExpression: 'set handicap = :handicap, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':handicap': Math.max(0, Math.min(54, newHandicap)), // Clamp mellom 0 og 54
          ':updatedAt': new Date().toISOString(),
        },
      })
    );

    logger.info(
      `Updated handicap for user ${userId}: ${newHandicap.toFixed(1)} (from ${
        rounds.length
      } rounds)`
    );
  } catch (error) {
    logger.error('Error updating handicap:', error);
    // Ikke kast feil - handicap-oppdatering skal ikke stoppe runde-lagring
  }
};

/**
 * GET /api/rounds?limit=20&nextToken=...
 * Hent runder for innlogget bruker med paginering
 */
export const getRounds = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const limit = parseInt(req.query.limit as string) || 20;
    const nextToken = req.query.nextToken as string | undefined;

    // Validate limit
    if (limit < 1 || limit > 100) {
      res.status(400).json({ message: 'Limit må være mellom 1 og 100' });
      return;
    }

    const queryParams: any = {
      TableName: TABLES.ROUNDS,
      IndexName: 'userId-date-index',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId,
      },
      ScanIndexForward: false, // Nyeste først
      Limit: limit,
    };

    // Add pagination token if provided
    if (nextToken) {
      try {
        queryParams.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, 'base64').toString());
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (_error) {
        res.status(400).json({ message: 'Ugyldig nextToken' });
        return;
      }
    }

    const result = await dynamodb.send(new QueryCommand(queryParams));

    // Encode LastEvaluatedKey as base64 token
    const responseNextToken = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : null;

    res.json({
      rounds: result.Items || [],
      nextToken: responseNextToken,
      hasMore: !!result.LastEvaluatedKey,
    });
  } catch (error) {
    logger.error('Get rounds error:', error);
    res.status(500).json({ message: 'Kunne ikke hente runder' });
  }
};

/**
 * GET /api/rounds/:id
 * Hent en spesifikk runde
 */
export const getRound = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;

    const result = await dynamodb.send(
      new GetCommand({
        TableName: TABLES.ROUNDS,
        Key: { id },
      })
    );

    if (!result.Item) {
      res.status(404).json({ message: 'Runde ikke funnet' });
      return;
    }

    // Sjekk at runden tilhører bruker
    if (result.Item.userId !== userId) {
      res.status(403).json({ message: 'Ingen tilgang' });
      return;
    }

    res.json(result.Item);
  } catch (error) {
    logger.error('Get round error:', error);
    res.status(500).json({ message: 'Kunne ikke hente runde' });
  }
};

/**
 * POST /api/rounds/by-criteria
 * Hent runder basert på dato, bane og spillere
 * Brukes for å finne relaterte runder i en multi-player gruppe
 */
export const getRoundsByCriteria = async (req: Request, res: Response): Promise<void> => {
  try {
    const { date, courseId, userIds } = req.body;

    if (!date || !courseId || !userIds || !Array.isArray(userIds)) {
      res.status(400).json({ message: 'date, courseId og userIds er påkrevd' });
      return;
    }

    // Hent runder for hver bruker på den gitte datoen
    const roundPromises = userIds.map(async (userId: string) => {
      const result = await dynamodb.send(
        new QueryCommand({
          TableName: TABLES.ROUNDS,
          IndexName: 'userId-date-index',
          KeyConditionExpression: 'userId = :userId AND #date = :date',
          FilterExpression: 'courseId = :courseId',
          ExpressionAttributeNames: {
            '#date': 'date',
          },
          ExpressionAttributeValues: {
            ':userId': userId,
            ':date': date,
            ':courseId': courseId,
          },
        })
      );

      // Returner første match (skal bare være én per bruker per dato/bane)
      return result.Items && result.Items.length > 0 ? result.Items[0] : null;
    });

    const rounds = await Promise.all(roundPromises);
    // Filtrer bort null-verdier
    const validRounds = rounds.filter(r => r !== null);

    res.json(validRounds);
  } catch (error) {
    logger.error('Get rounds by criteria error:', error);
    res.status(500).json({ message: 'Kunne ikke hente runder' });
  }
};

/**
 * POST /api/rounds
 * Opprett ny runde
 */
export const createRound = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const roundData = req.body as CreateRoundInput;

    // Hent course fra database for å få rating og slope
    const courseResult = await dynamodb.send(
      new GetCommand({
        TableName: TABLES.COURSES,
        Key: { id: roundData.courseId },
      })
    );

    if (!courseResult.Item) {
      res.status(404).json({ message: 'Golfbane ikke funnet' });
      return;
    }

    const course = courseResult.Item;

    // For 9-hulls: bruk halvparten av 18-hulls rating
    // WHS krever at vi sender 9-hulls rating til calculateScoreDifferential
    const courseRating =
      roundData.numberOfHoles === 9
        ? course.rating[roundData.teeColor] / 2
        : course.rating[roundData.teeColor];

    // Slope forblir full 18-hulls verdi (per WHS)
    const slopeRating = course.slope[roundData.teeColor];

    // Beregn total score og par
    const totalScore = roundData.holes.reduce((sum, hole) => sum + hole.strokes, 0);
    const totalPar = roundData.holes.reduce((sum, hole) => sum + hole.par, 0);

    // calculateScoreDifferential håndterer 9-hulls automatisk
    const scoreDifferential = calculateScoreDifferential(
      totalScore,
      courseRating,
      slopeRating,
      roundData.numberOfHoles
    );

    const roundId = uuidv4();
    const timestamp = new Date().toISOString();

    const round = {
      id: roundId,
      userId,
      ...roundData,
      totalScore,
      totalPar,
      scoreDifferential,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await dynamodb.send(
      new PutCommand({
        TableName: TABLES.ROUNDS,
        Item: round,
      })
    );

    // Oppdater brukerens handicap basert på WHS
    if (userId) {
      await updateUserHandicap(userId);
    }

    res.status(201).json(round);
  } catch (error) {
    logger.error('Create round error:', error);
    res.status(500).json({ message: 'Kunne ikke opprette runde' });
  }
};

/**
 * POST /api/rounds/multi-player
 * Opprett runde for flere spillere samtidig
 * Dette oppretter én runde per spiller med deres individuelle scores
 */
export const createMultiPlayerRound = async (req: Request, res: Response): Promise<void> => {
  try {
    const requestingUserId = req.user?.userId;
    const roundData = req.body as CreateMultiPlayerRoundInput;

    // Verify that the requesting user is one of the players
    const playerIds = roundData.playerScores.map(ps => ps.playerId);
    if (!playerIds.includes(requestingUserId!)) {
      res.status(403).json({ message: 'Du må være en av spillerne i runden' });
      return;
    }

    // Verify all players exist
    const playerChecks = await Promise.all(
      playerIds.map(playerId =>
        dynamodb.send(
          new GetCommand({
            TableName: TABLES.USERS,
            Key: { id: playerId },
          })
        )
      )
    );

    const missingPlayers = playerChecks.filter(result => !result.Item);
    if (missingPlayers.length > 0) {
      res.status(400).json({ message: 'En eller flere spillere finnes ikke i systemet' });
      return;
    }

    // Hent course fra database for å få rating og slope
    const courseResult = await dynamodb.send(
      new GetCommand({
        TableName: TABLES.COURSES,
        Key: { id: roundData.courseId },
      })
    );

    if (!courseResult.Item) {
      res.status(404).json({ message: 'Golfbane ikke funnet' });
      return;
    }

    const course = courseResult.Item;

    // For 9-hulls: bruk halvparten av 18-hulls rating
    // WHS krever at vi sender 9-hulls rating til calculateScoreDifferential
    const courseRating =
      roundData.numberOfHoles === 9
        ? course.rating[roundData.teeColor] / 2
        : course.rating[roundData.teeColor];

    // Slope forblir full 18-hulls verdi (per WHS)
    const slopeRating = course.slope[roundData.teeColor];

    const timestamp = new Date().toISOString();
    const createdRounds = [];

    // Create a round for each player
    for (const playerScore of roundData.playerScores) {
      const totalScore = playerScore.holes.reduce((sum, hole) => sum + hole.strokes, 0);
      const totalPar = playerScore.holes.reduce((sum, hole) => sum + hole.par, 0);

      // calculateScoreDifferential håndterer 9-hulls automatisk
      const scoreDifferential = calculateScoreDifferential(
        totalScore,
        courseRating,
        slopeRating,
        roundData.numberOfHoles
      );

      const roundId = uuidv4();

      // Get list of other players (excluding current player)
      const otherPlayers = playerIds.filter(id => id !== playerScore.playerId);

      const round = {
        id: roundId,
        userId: playerScore.playerId,
        courseId: roundData.courseId,
        courseName: roundData.courseName,
        teeColor: roundData.teeColor,
        numberOfHoles: roundData.numberOfHoles,
        date: roundData.date,
        players: otherPlayers, // Other players in the round
        holes: playerScore.holes,
        totalScore,
        totalPar,
        scoreDifferential,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await dynamodb.send(
        new PutCommand({
          TableName: TABLES.ROUNDS,
          Item: round,
        })
      );

      createdRounds.push(round);

      // Update handicap for this player
      await updateUserHandicap(playerScore.playerId);
    }

    res.status(201).json({
      message: `Successfully created ${createdRounds.length} rounds`,
      rounds: createdRounds,
    });
  } catch (error) {
    logger.error('Create multi-player round error:', error);
    res.status(500).json({ message: 'Kunne ikke opprette runde' });
  }
};

/**
 * PUT /api/rounds/:id
 * Oppdater eksisterende runde
 */
export const updateRound = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const updates = req.body;

    // Sjekk at runden tilhører bruker
    const existing = await dynamodb.send(
      new GetCommand({
        TableName: TABLES.ROUNDS,
        Key: { id },
      })
    );

    if (!existing.Item || existing.Item.userId !== userId) {
      res.status(403).json({ message: 'Ingen tilgang' });
      return;
    }

    // Oppdater runde
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLES.ROUNDS,
        Key: { id },
        UpdateExpression: 'set holes = :holes, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':holes': updates.holes,
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      })
    );

    res.json(result.Attributes);
  } catch (error) {
    logger.error('Update round error:', error);
    res.status(500).json({ message: 'Kunne ikke oppdatere runde' });
  }
};

/**
 * DELETE /api/rounds/:id
 * Slett runde og alle relaterte runder (multi-player)
 */
export const deleteRound = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;

    // Hent runden som skal slettes
    const existing = await dynamodb.send(
      new GetCommand({
        TableName: TABLES.ROUNDS,
        Key: { id },
      })
    );

    if (!existing.Item || existing.Item.userId !== userId) {
      res.status(403).json({ message: 'Ingen tilgang' });
      return;
    }

    const round = existing.Item;

    // Finn alle relaterte runder (samme dato/bane med andre spillere)
    let relatedRounds: any[] = [];
    if (round.players && round.players.length > 0) {
      // Dette er en multi-player runde, finn alle spillernes runder
      // Inkluder både deg selv (userId) og alle i players-arrayet
      const allPlayerIds = [userId, ...round.players];

      const relatedRoundsResult = await Promise.all(
        allPlayerIds.map(async (playerId: string) => {
          const result = await dynamodb.send(
            new QueryCommand({
              TableName: TABLES.ROUNDS,
              IndexName: 'userId-date-index',
              KeyConditionExpression: 'userId = :userId AND #date = :date',
              FilterExpression: 'courseId = :courseId',
              ExpressionAttributeNames: {
                '#date': 'date',
              },
              ExpressionAttributeValues: {
                ':userId': playerId,
                ':date': round.date,
                ':courseId': round.courseId,
              },
            })
          );
          return result.Items || [];
        })
      );
      relatedRounds = relatedRoundsResult.flat();
    } else {
      // Single-player runde, bare denne
      relatedRounds = [round];
    }

    // Slett alle relaterte runder
    const deletePromises = relatedRounds.map(r =>
      dynamodb.send(
        new DeleteCommand({
          TableName: TABLES.ROUNDS,
          Key: { id: r.id },
        })
      )
    );

    await Promise.all(deletePromises);

    // Oppdater handicap for alle berørte spillere
    const uniquePlayerIds = [...new Set(relatedRounds.map(r => r.userId))];
    await Promise.all(uniquePlayerIds.map(playerId => updateUserHandicap(playerId)));

    res.json({
      message: `${relatedRounds.length} runde${relatedRounds.length > 1 ? 'r' : ''} slettet`,
      deletedCount: relatedRounds.length,
    });
  } catch (error) {
    logger.error('Delete round error:', error);
    res.status(500).json({ message: 'Kunne ikke slette runde' });
  }
};
