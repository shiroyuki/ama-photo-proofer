import { expect, it } from 'vitest';
import { summarySlug } from '../shared/summary';
it('bounds summaries and permits only lowercase ASCII alphanumeric words separated by hyphens', () => {
  expect(summarySlug(' Café / Sunrise!\nBy the Lake ')).toBe('cafe-sunrise-by-the-lake');
  expect(summarySlug('../../SUNRISE_2026')).toBe('sunrise-2026');
  expect(summarySlug('one two three four five six seven')).toBe('one-two-three-four-five-six');
  expect(summarySlug('X'.repeat(100))).toHaveLength(64);
  expect(summarySlug('CON')).toBe('con-event');
  expect(summarySlug('山 / !!!')).toBeUndefined(); expect(summarySlug(null)).toBeUndefined();
});
