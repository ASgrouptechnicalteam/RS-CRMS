export function slugify(input: string): string {
  if (!input || !input.trim()) {
    return '';
  }

  return input
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function generateUniqueSlug(
  baseSlug: string,
  companyId: number,
  checkExists: (slug: string, companyId: number) => Promise<boolean>,
): Promise<string> {
  if (!baseSlug) {
    return '';
  }

  let slug = baseSlug;
  let counter = 0;

  while (await checkExists(slug, companyId)) {
    counter++;
    slug = `${baseSlug}-${counter}`;
  }

  return slug;
}