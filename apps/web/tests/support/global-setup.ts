import {
  PILOT_CONTENT,
  PILOT_EXAM,
  PILOT_TRACK_ID,
} from '../../../../scripts/seed-pilot-question';
import type { PilotAudio } from '../../../../scripts/seed-pilot-question';
import { publishExamVersion } from '../../../../scripts/lib/publish-exam-version';
import { serviceDb } from './db';
import {
  FULL_EXAM,
  FULL_PILOT,
  FULL_TIMING,
  FULL_TRACK_ID,
  ensureConfirmedTestProfile,
} from './full-exam';
import { PAIR_CONTENT, PAIR_EXAM, PAIR_KEYS, PAIR_TRACK_ID } from './pair-exam';
import { sqlRunnerAs } from './sql';

// The test database gets the real pilot short set through the trusted owner
// path, with a test-only key and a synthetic recording: neither the
// publisher's key nor the original audio is ever committed.
export const TEST_PILOT_KEYS = {
  'hoeren-1': 'c',
  'hoeren-2': 'a',
  'hoeren-3': 'b',
  'hoeren-4': 'c',
} as const;

export const TEST_AUDIO_SECONDS = 60;

const SAMPLE_RATE = 8000;
const TONE_HZ = 440;
const AMPLITUDE = 3000;

// A deterministic 16-bit mono PCM WAV with a quiet tone: the same bytes on
// every run, so a repeated publication finds the same version. Another tone
// gives another recording with its own SHA-256.
export const createTestRecording = (toneHz: number = TONE_HZ): PilotAudio => {
  const samples = SAMPLE_RATE * TEST_AUDIO_SECONDS;
  const dataBytes = samples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples; i++) {
    const value = Math.sin((2 * Math.PI * toneHz * i) / SAMPLE_RATE);
    view.setInt16(44 + i * 2, Math.round(value * AMPLITUDE), true);
  }
  return { contentType: 'audio/wav', bytes: new Uint8Array(buffer) };
};

const globalSetup = async () => {
  await publishExamVersion(serviceDb, {
    ...PILOT_EXAM,
    content: PILOT_CONTENT,
    keys: TEST_PILOT_KEYS,
    audio: [{ trackId: PILOT_TRACK_ID, ...createTestRecording() }],
  });
  await publishExamVersion(serviceDb, {
    ...PAIR_EXAM,
    content: PAIR_CONTENT,
    keys: PAIR_KEYS,
    audio: [{ trackId: PAIR_TRACK_ID, ...createTestRecording() }],
  });
  const full = await publishExamVersion(serviceDb, {
    ...FULL_EXAM,
    content: FULL_PILOT.content,
    keys: FULL_PILOT.keys,
    audio: [{ trackId: FULL_TRACK_ID, ...createTestRecording() }],
  });
  // Only here, in the isolated test database, the test set gets a confirmed
  // timing profile; a repeated setup creates no new revision.
  ensureConfirmedTestProfile(sqlRunnerAs('owner'), full.versionId, FULL_TIMING);
};

export default globalSetup;
