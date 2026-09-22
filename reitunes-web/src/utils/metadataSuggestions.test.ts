import { expect, it } from 'vitest';
import type { LibraryItem } from '../types';
import { completeMetadata, metadataSuggestions } from './metadataSuggestions';

it('ignores blank metadata and combines duplicates without changing stored capitalization', () => {
  const items = [
    { artist: ' Nina Simone ', album: 'Pastel Blues' },
    { artist: 'nina simone', album: 'Little Girl Blue' },
    { artist: 'Nick Drake', album: 'Pastel Blues' },
    { artist: '  ', album: '' },
  ] as LibraryItem[];
  expect(metadataSuggestions(items, 'artist')).toEqual(['Nick Drake', 'Nina Simone']);
  expect(metadataSuggestions(items, 'album')).toEqual(['Little Girl Blue', 'Pastel Blues']);
});

it('completes prefixes regardless of case but allows empty and new values', () => {
  const suggestions = ['Nick Drake', 'Nina Simone'];
  expect(completeMetadata('ni', suggestions)).toBe('Nick Drake');
  expect(completeMetadata('nINa', suggestions)).toBe('Nina Simone');
  expect(completeMetadata('Nina Simone', suggestions)).toBe('Nina Simone');
  expect(completeMetadata('Nina Other', suggestions)).toBe('Nina Other');
  expect(completeMetadata('', suggestions)).toBe('');
});
