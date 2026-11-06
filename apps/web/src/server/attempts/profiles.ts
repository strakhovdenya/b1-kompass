import { z } from 'zod';
import type { ServerDeps } from '../db';

// Read-only adapter of the trusted timing profile of a published version.
// It asks the database gate for the current confirmed revision: a draft
// head, a missing profile or a mismatch with the version or its recording
// give null, never an older confirmed revision. Creating and confirming a
// profile belong only to the owner tool (scripts/manage-timing-profile.ts);
// no HTTP route and no runtime role can do either.
// The profile is exam configuration, not guest data, like the published
// version itself: a guest-facing caller checks its session as for any other
// operation before it acts on the value. This read only informs; the timed start of #43 calls the same gate inside
// its SQL transaction and pins the revision there, never from this value.

const HEX_64 = /^[0-9a-f]{64}$/;

const secondsSchema = z.number().int().positive();

const snapshotSchema = z.object({
  revisionId: z.uuid(),
  examVersionId: z.uuid(),
  revision: z.number().int().positive(),
  recordingSeconds: secondsSchema,
  hoerenSeconds: secondsSchema,
  transitionSeconds: secondsSchema,
  lesenSeconds: secondsSchema,
  fingerprint: z.string().regex(HEX_64),
  status: z.literal('confirmed'),
});

export interface ConfirmedTimingProfile {
  revisionId: string;
  examVersionId: string;
  revision: number;
  recordingSeconds: number;
  hoerenSeconds: number;
  transitionSeconds: number;
  lesenSeconds: number;
  fingerprint: string;
}

export const readConfirmedTimingProfile = async (
  deps: ServerDeps,
  versionId: string,
): Promise<ConfirmedTimingProfile | null> => {
  const { data, error } = await deps.db.rpc('m2_confirmed_timing_profile', {
    p_version_id: versionId,
  });
  if (error) throw new Error('Timing profile lookup failed', { cause: error });
  if (data === null) return null;
  const parsed = snapshotSchema.safeParse(data);
  if (!parsed.success) throw new Error('Timing profile snapshot is malformed');
  const profile = parsed.data;
  if (profile.examVersionId !== versionId) {
    throw new Error('Timing profile belongs to another version');
  }
  return {
    revisionId: profile.revisionId,
    examVersionId: profile.examVersionId,
    revision: profile.revision,
    recordingSeconds: profile.recordingSeconds,
    hoerenSeconds: profile.hoerenSeconds,
    transitionSeconds: profile.transitionSeconds,
    lesenSeconds: profile.lesenSeconds,
    fingerprint: profile.fingerprint,
  };
};
