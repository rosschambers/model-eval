// Ground truth: `SELECT a, b, word_similarity(a, b), a <% b` run read-only against serve's
// murmur8-postgres (database murmur8, pg_trgm.word_similarity_threshold = 0.3 from
// pg_db_role_setting) on 2026-10-01. The expected values are psql's float4 text.
import { describe, it, expect } from 'vitest';
import { WORD_SIMILARITY_THRESHOLD, matchesWordSimilarity, wordSimilarity } from './trigram.js';

const PRODUCTION_ROWS: Array<[string, string, string, boolean]> = [
  ['Shopping', 'Shopping', '1', true],
  ['Shopping', 'groceries', '0', false],
  ['Shopping list', 'Shopping', '0.64285713', true],
  ['shop', 'Shopping', '0.8', true],
  ['grocery', 'groceries', '0.75', true],
  ['Personal', 'Personal', '1', true],
  ['water bill', 'Pay water bill', '1', true],
  ['review task', 'Review the quarterly numbers', '0.6666667', true],
  ['dentist', 'Murmur8', '0', false],
  ['mur', 'Murmur8', '0.75', true],
  ['house', 'Household', '0.8333333', true],
  ['connect wise', 'Connectwise', '0.6666667', true],
  ['ab', 'Shopping', '0', false],
  ['pping', 'Shopping', '0.6666667', true],
  ['budget review', 'Personal', '0', false],
  ['Grocery list', 'groceries', '0.46153846', true],
  ['aaa aaa', 'xaaa aaay', '1', true],
  ['Shopping', 'My Shopping List', '1', true],
  ['list', 'Shopping', '0', false],
  ['groceries list', 'groceries', '0.6666667', true],
  ['Murmur8', 'murmur', '0.71428573', true],
  ['calendar', 'Personal', '0', false],
  ['work', 'Connectwise', '0', false],
  ['Household', 'household chores', '1', true],
  ['ing', 'Shopping', '0.5', true],
  ['ping pong', 'Shopping', '0.375', true],
  ['Person', 'Personal', '0.85714287', true],
  ['dentist', 'Dentist appointment', '1', true],
];

describe('wordSimilarity (pg_trgm word_similarity port)', () => {
  it('uses the production database threshold', () => {
    expect(WORD_SIMILARITY_THRESHOLD).toBe(0.3);
  });

  for (const [query, text, expectedText, expectedMatch] of PRODUCTION_ROWS) {
    it(`word_similarity('${query}', '${text}') = ${expectedText}, <% is ${expectedMatch}`, () => {
      // JSON.stringify writes the float4 the way System.Text.Json and psql do.
      expect(JSON.stringify(wordSimilarity(query, text))).toBe(expectedText);
      expect(matchesWordSimilarity(query, text)).toBe(expectedMatch);
    });
  }

  it('is zero for text with no word characters', () => {
    expect(wordSimilarity('Shopping', '')).toBe(0);
    expect(wordSimilarity('', 'Shopping')).toBe(0);
    expect(wordSimilarity('!!', '??')).toBe(0);
  });
});
