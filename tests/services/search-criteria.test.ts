/**
 * @fileoverview The blank-criterion rule for the search tools: what counts as absent, what is
 * sent as given, and that the check stays linear in caller-sized text.
 * @module tests/services/search-criteria.test
 */

import { describe, expect, it } from 'vitest';
import { bookSearchCriteria, isBlank } from '@/services/open-library/search-criteria.js';
import { expectLinearTime } from '../timing.js';

describe('bookSearchCriteria', () => {
  it('keeps non-blank values exactly as given, in request order', () => {
    expect(
      Object.entries(
        bookSearchCriteria({ isbn: ' 978-0 ', title: ' faust ', query: ' ab', author: undefined }),
      ),
    ).toEqual([
      ['query', ' ab'],
      ['title', ' faust '],
      ['isbn', ' 978-0 '],
    ]);
  });

  it('treats an isbn of hyphens and whitespace as blank, and hyphens elsewhere as text', () => {
    expect(bookSearchCriteria({ isbn: ' -\t- ', title: '-' })).toEqual({ title: '-' });
  });

  it.each(['', ' ', '\t\r\n', ' '])('reads %j as blank', (value) => {
    expect(isBlank(value)).toBe(true);
  });

  it.each([
    ['one long line ending in a break', (size: number) => `${'§1 x'.repeat(size / 4)}\ny`],
    ['breaks throughout', (size: number) => '  \r\n'.repeat(size / 4)],
    ['a long digit run', (size: number) => '7'.repeat(size)],
    ['a run of hyphens', (size: number) => '-'.repeat(size)],
    ['nested openers', (size: number) => '<a'.repeat(size / 2)],
  ])(
    'reads every criterion of %s in linear time',
    (_shape, make) => {
      expectLinearTime(make, (text) =>
        bookSearchCriteria({
          query: text,
          title: text,
          author: text,
          subject: text,
          publisher: text,
          isbn: text,
        }),
      );
    },
    0,
  );
});
