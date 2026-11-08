import type { Category, Settings } from './types.ts';

export const DEFAULT_CATEGORIES: readonly Category[] = [
  { id: 'typo', name: 'Typo', color: '#d97706', kind: 'comment', weight: 1 },
  { id: 'error', name: 'Error', color: '#dc2626', kind: 'comment', weight: 3 },
  { id: 'remark', name: 'General remark', color: '#2563eb', kind: 'comment', weight: 2 },
  { id: 'good', name: 'Well done', color: '#16a34a', kind: 'comment', weight: 1 },
  { id: 'hl', name: 'Highlight', color: '#facc15', kind: 'highlight', weight: 0 },
];

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  marginWidth: 150,
  maxEnlargement: 1.3,
  fontSize: 9,
  leaderStyle: 'full',
  embedOriginal: false,
};

/** Weight used when a category omits it. */
export const DEFAULT_WEIGHT = 1;
