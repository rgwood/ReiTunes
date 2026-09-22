import type { LibraryItem } from '../types';

export function metadataSuggestions(items: LibraryItem[], field: 'artist' | 'album'): string[] {
  const unique = new Map<string, string>();
  for (const item of items) {
    const value = item[field].trim();
    if (value && !unique.has(value.toLocaleLowerCase())) unique.set(value.toLocaleLowerCase(), value);
  }
  return [...unique.values()].sort((a, b) => a.localeCompare(b));
}

export function completeMetadata(prefix: string, suggestions: readonly string[]): string {
  if (!prefix) return prefix;
  return suggestions.find(value => value.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) ?? prefix;
}
