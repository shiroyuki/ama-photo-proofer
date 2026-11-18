/** A bounded, portable folder-name suffix: ASCII lowercase letters, numbers and hyphens. */
export function summarySlug(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const slug = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-').slice(0, 64).replace(/-+$/g, '');
  if (!slug) return;
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(slug) ? `${slug}-event` : slug;
}
