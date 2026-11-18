export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((tag): tag is string => typeof tag === 'string')
    .map(tag => tag.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(tag => tag.length > 0 && tag.length <= 40 && /^[\p{L}\p{N}][\p{L}\p{N}\s-]*$/u.test(tag)))].slice(0, 12);
}
