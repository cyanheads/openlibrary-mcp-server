/**
 * @fileoverview Language code tables: every code the `language` filter maps to is an Open
 * Library language record, and every code it accepts as given is a record or a MARC code, so no
 * accepted code is a typo that silently matches nothing.
 * @module tests/services/language-codes.test
 */

import { describe, expect, it } from 'vitest';
import {
  MARC_LANGUAGE_BY_ISO_639_1,
  MARC_LANGUAGE_BY_ISO_639_2T,
  normalizeLanguageCode,
} from '@/services/open-library/language-codes.js';
import { OPEN_LIBRARY_LANGUAGE_CODES } from '@/services/open-library/language-records.js';

describe('Open Library language records snapshot', () => {
  it('holds the 513 lowercase 3-letter record codes of 2026-11-15', () => {
    expect(OPEN_LIBRARY_LANGUAGE_CODES.size).toBe(513);
    for (const code of OPEN_LIBRARY_LANGUAGE_CODES) expect(code).toMatch(/^[a-z]{3}$/);
  });

  it.each(['cmn', 'yue', 'esk', 'und', 'mul', 'eng', 'chi'])('carries %s', (code) => {
    expect(OPEN_LIBRARY_LANGUAGE_CODES.has(code)).toBe(true);
  });

  it.each(['zxx', 'qqq', 'deu', 'ajm'])('carries no record for %s', (code) => {
    expect(OPEN_LIBRARY_LANGUAGE_CODES.has(code)).toBe(false);
  });
});

describe('language code mappings', () => {
  it('maps every 2-letter code to a language record', () => {
    const missing = Object.entries(MARC_LANGUAGE_BY_ISO_639_1).filter(
      ([, marc]) => !OPEN_LIBRARY_LANGUAGE_CODES.has(marc),
    );
    expect(missing).toEqual([]);
  });

  it('maps exactly the 20 terminology codes, each to a record and none itself a record', () => {
    const entries = Object.entries(MARC_LANGUAGE_BY_ISO_639_2T);
    expect(entries).toHaveLength(20);
    for (const [terminology, marc] of entries) {
      expect(OPEN_LIBRARY_LANGUAGE_CODES.has(marc)).toBe(true);
      // A terminology code that were a record would be hidden behind its mapping.
      expect(OPEN_LIBRARY_LANGUAGE_CODES.has(terminology)).toBe(false);
    }
  });

  it('accepts every record code as itself, in any case', () => {
    for (const code of OPEN_LIBRARY_LANGUAGE_CODES) {
      expect(normalizeLanguageCode(code)).toBe(code);
      expect(normalizeLanguageCode(code.toUpperCase())).toBe(code);
    }
  });

  it.each([
    ['deu', 'ger'],
    ['Zho', 'chi'],
    ['BOD', 'tib'],
    ['de', 'ger'],
  ])('normalizes %s to %s', (code, marc) => {
    expect(normalizeLanguageCode(code)).toBe(marc);
  });

  it.each(['zxx', 'ajm', 'kus', 'max', 'tru'])(
    'accepts the MARC code %s, which no Open Library record carries, as itself in any case',
    (code) => {
      expect(normalizeLanguageCode(code)).toBe(code);
      expect(normalizeLanguageCode(code.toUpperCase())).toBe(code);
    },
  );

  it.each(['qqq', 'xyz', 'xx'])('rejects %s as unknown_language_code', (code) => {
    expect(() => normalizeLanguageCode(code)).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'unknown_language_code' }),
      }),
    );
  });
});
