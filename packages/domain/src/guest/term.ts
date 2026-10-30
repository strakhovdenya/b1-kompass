export const GUEST_TERM_HOURS = 720;

const GUEST_TERM_MS = GUEST_TERM_HOURS * 60 * 60 * 1000;

export const computeGuestExpiry = (createdAt: Date): Date =>
  new Date(createdAt.getTime() + GUEST_TERM_MS);

export const isGuestActive = (expiresAt: Date, now: Date): boolean =>
  now.getTime() < expiresAt.getTime();
