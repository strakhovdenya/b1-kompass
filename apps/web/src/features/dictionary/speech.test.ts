import { describe, expect, it } from 'vitest';
import { GERMAN_SPEECH_LANG, speakGerman } from './speech';
import type { SpeechEnvironment } from './speech';

interface Spoken {
  text: string;
  lang: string;
  voice: unknown;
  rate: number;
}

// The training recording, as far as the speech code could reach it.
const trainingAudio = () => ({
  paused: false,
  currentTime: 42,
  muted: false,
  volume: 1,
});

const fakeSpeech = (voices: { lang: string; name: string }[]) => {
  const spoken: Spoken[] = [];
  let cancelled = 0;
  class Utterance {
    lang = '';
    voice: unknown = null;
    rate = 1;
    constructor(public text: string) {}
  }
  const environment: SpeechEnvironment = {
    speechSynthesis: {
      getVoices: () => voices,
      cancel: () => {
        cancelled += 1;
      },
      speak: (utterance: never) => {
        spoken.push(utterance as Spoken);
      },
    },
    SpeechSynthesisUtterance: Utterance,
  };
  return { environment, spoken, cancelled: () => cancelled };
};

describe('German pronunciation', () => {
  it('speaks selected German word only', () => {
    const audio = trainingAudio();
    const before = { ...audio };
    const german = { lang: 'de-DE', name: 'Anna' };
    const speech = fakeSpeech([{ lang: 'en-US', name: 'Sam' }, german]);

    expect(speakGerman('Lücke', speech.environment)).toBe('started');
    expect(speech.spoken).toHaveLength(1);
    expect(speech.spoken[0]).toMatchObject({
      text: 'Lücke',
      lang: GERMAN_SPEECH_LANG,
      voice: german,
    });
    // Only queued speech is cancelled; the recording is untouched.
    expect(speech.cancelled()).toBe(1);
    expect(audio).toEqual(before);

    // Voices not loaded yet: the utterance still asks for de-DE.
    const early = fakeSpeech([]);
    expect(speakGerman('Brief', early.environment)).toBe('started');
    expect(early.spoken[0]).toMatchObject({ text: 'Brief', lang: 'de-DE' });
  });

  it('handles unavailable German speech gracefully', () => {
    const audio = trainingAudio();
    const before = { ...audio };

    expect(speakGerman('Brief', {})).toBe('unavailable');

    const englishOnly = fakeSpeech([{ lang: 'en-GB', name: 'Kate' }]);
    expect(speakGerman('Brief', englishOnly.environment)).toBe(
      'no-german-voice',
    );
    expect(englishOnly.spoken).toHaveLength(0);
    expect(englishOnly.cancelled()).toBe(0);

    const broken: SpeechEnvironment = {
      speechSynthesis: {
        getVoices: () => {
          throw new Error('blocked');
        },
        cancel: () => undefined,
        speak: () => undefined,
      },
      SpeechSynthesisUtterance: class {
        lang = '';
        voice: unknown = null;
        rate = 1;
      },
    };
    expect(speakGerman('Brief', broken)).toBe('unavailable');
    expect(audio).toEqual(before);
  });
});
