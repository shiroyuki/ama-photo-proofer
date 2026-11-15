import { describe, expect, it } from 'vitest';
import { clickSelection } from '../shared/selection';
const order = ['a', 'b', 'c', 'd', 'e'];
describe('desktop selection', () => {
  it('selects one item, deselects on a repeated click, and replaces a group on plain click', () => {
    expect([...clickSelection(order, new Set(), '', 'b', {}).ids]).toEqual(['b']);
    expect([...clickSelection(order, new Set(['b']), 'b', 'b', {}).ids]).toEqual([]);
    expect([...clickSelection(order, new Set(['a', 'b']), 'a', 'd', {}).ids]).toEqual(['d']);
  });
  it('toggles individual photos with the additive modifier', () => {
    expect([...clickSelection(order, new Set(['a']), 'a', 'c', { additive: true }).ids]).toEqual(['a', 'c']);
    expect([...clickSelection(order, new Set(['a', 'c']), 'a', 'a', { additive: true }).ids]).toEqual(['c']);
  });
  it('selects ranges in either direction while retaining the original anchor', () => {
    const result = clickSelection(order, new Set(['d']), 'd', 'b', { shift: true });
    expect([...result.ids]).toEqual(['b', 'c', 'd']); expect(result.anchor).toBe('d');
    expect([...clickSelection(order, result.ids, result.anchor, 'e', { shift: true }).ids]).toEqual(['d', 'e']);
  });
  it('adds ranges and handles a missing anchor after filtering', () => {
    expect([...clickSelection(order, new Set(['a']), 'c', 'e', { shift: true, additive: true }).ids]).toEqual(['a', 'c', 'd', 'e']);
    expect([...clickSelection(['c', 'd'], new Set(['a']), 'a', 'd', { shift: true }).ids]).toEqual(['d']);
  });
});
