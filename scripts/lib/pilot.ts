import type { Inventory } from '@b1k/domain';

// The full pilot: all Hören tasks belong to the one recording of telc Track
// 127; the short set of seed-pilot-question.ts has its own track id.
export const PILOT_INVENTORY: Inventory = { hoeren: 20, lesen: 25 };

export const FULL_PILOT_TRACK_ID = 'track-127';
