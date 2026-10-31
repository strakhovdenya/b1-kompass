import { publishPilotShortSet } from '../../../../scripts/seed-pilot-question';
import type { PilotAudio } from '../../../../scripts/seed-pilot-question';
import { serviceDb } from './db';

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
// every run, so a repeated publication finds the same version.
export const createTestRecording = (): PilotAudio => {
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
    const value = Math.sin((2 * Math.PI * TONE_HZ * i) / SAMPLE_RATE);
    view.setInt16(44 + i * 2, Math.round(value * AMPLITUDE), true);
  }
  return { contentType: 'audio/wav', bytes: new Uint8Array(buffer) };
};

const globalSetup = async () => {
  await publishPilotShortSet(serviceDb, TEST_PILOT_KEYS, createTestRecording());
};

export default globalSetup;
