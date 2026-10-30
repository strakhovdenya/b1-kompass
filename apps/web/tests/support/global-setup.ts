import { publishPilotQuestion } from '../../../../scripts/seed-pilot-question';
import { serviceDb } from './db';

// The test database gets the real pilot question through the trusted owner
// path, with a test-only key: the publisher's key is never committed.
export const TEST_PILOT_KEYS = { 'hoeren-1': 'c' } as const;

const globalSetup = async () => {
  await publishPilotQuestion(serviceDb, TEST_PILOT_KEYS);
};

export default globalSetup;
