export interface SelectionModifiers { shift?: boolean; additive?: boolean }
export function clickSelection(order: string[], current: Set<string>, anchor: string, target: string, modifiers: SelectionModifiers) {
  const valid = new Set(order);
  const ids = new Set([...current].filter(id => valid.has(id)));
  if (modifiers.shift) {
    const start = order.indexOf(anchor);
    const end = order.indexOf(target);
    const range = start < 0 ? [target] : order.slice(Math.min(start, end), Math.max(start, end) + 1);
    return { ids: new Set(modifiers.additive ? [...ids, ...range] : range), anchor: start < 0 ? target : anchor };
  }
  if (modifiers.additive) {
    if (ids.has(target)) ids.delete(target); else ids.add(target);
    return { ids, anchor: target };
  }
  return { ids: ids.size === 1 && ids.has(target) ? new Set<string>() : new Set([target]), anchor: target };
}
export type ReviewStatus = 'accepted' | 'rejected';
