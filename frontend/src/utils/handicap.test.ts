import { describe, it, expect } from 'vitest';

/**
 * Basic utility function tests for frontend
 */
describe('Handicap utilities', () => {
  it('should format handicap correctly', () => {
    const formatHandicap = (hcp: number): string => {
      return hcp.toFixed(1);
    };

    expect(formatHandicap(19.1)).toBe('19.1');
    expect(formatHandicap(54)).toBe('54.0');
    expect(formatHandicap(0)).toBe('0.0');
  });

  it('should calculate score differential display', () => {
    const formatDifferential = (diff: number): string => {
      return diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
    };

    expect(formatDifferential(12.5)).toBe('+12.5');
    expect(formatDifferential(-2.3)).toBe('-2.3');
    expect(formatDifferential(0)).toBe('+0.0');
  });

  it('should validate score input', () => {
    const isValidScore = (score: number, par: number): boolean => {
      return score > 0 && score <= par * 3;
    };

    expect(isValidScore(4, 4)).toBe(true);
    expect(isValidScore(10, 4)).toBe(true);
    expect(isValidScore(13, 4)).toBe(false); // More than 3x par
    expect(isValidScore(0, 4)).toBe(false);
    expect(isValidScore(-1, 4)).toBe(false);
  });
});
