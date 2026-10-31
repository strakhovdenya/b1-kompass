import { z } from 'zod';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const MAX_PROGRESS_BYTES = 2048;
// Far beyond any recording of an exam; keeps a number from being absurd.
export const MAX_POSITION_SECONDS = 86_400;
const MAX_PARAGRAPH = 1_000;

const itemId = z.string().regex(SLUG).max(100);

// Where the guest stopped in Hören: a question or a group of the version.
const hoerenPlaceSchema = z.strictObject({ itemId: itemId.optional() });

// Where the guest stopped in Lesen: the task, its text and the paragraph.
const lesenPlaceSchema = z.strictObject({
  itemId: itemId.optional(),
  textId: z.string().regex(SLUG).max(100).optional(),
  paragraph: z.number().int().min(0).max(MAX_PARAGRAPH).optional(),
});

// Where the guest stopped. Only the block (the one the guest is in) is
// required; each block keeps its own place, so going to the other block and
// back finds the task again. Unknown fields (role, score, guestSessionId,
// ...) are rejected. New fields are added here, not in the consumers.
export const attemptProgressSchema = z
  .strictObject({
    block: z.enum(['hoeren', 'lesen']),
    positionSeconds: z.number().min(0).max(MAX_POSITION_SECONDS).optional(),
    hoeren: hoerenPlaceSchema.optional(),
    lesen: lesenPlaceSchema.optional(),
  })
  .refine(
    (value) => JSON.stringify(value).length <= MAX_PROGRESS_BYTES,
    'progress is too large',
  );

export type AttemptProgress = z.infer<typeof attemptProgressSchema>;

export type SaveProgressError =
  | 'invalid-input'
  | 'session-invalid'
  | 'attempt-not-found'
  | 'progress-not-allowed'
  | 'unavailable';

export type SaveProgressResult =
  | { ok: true; progress: AttemptProgress }
  | { ok: false; error: SaveProgressError };
