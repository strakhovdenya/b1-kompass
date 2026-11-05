// The pronunciation of the selected German word by the browser's speech
// synthesis. It speaks only the word, in de-DE, and never touches the audio
// element of the training: the recording keeps its own state.

export const GERMAN_SPEECH_LANG = 'de-DE';

export type SpeechResult = 'started' | 'unavailable' | 'no-german-voice';

interface VoiceLike {
  lang: string;
}

interface UtteranceLike {
  lang: string;
  voice: unknown;
  rate: number;
}

export interface SpeechEnvironment {
  speechSynthesis?: {
    getVoices: () => readonly VoiceLike[];
    cancel: () => void;
    speak: (utterance: never) => void;
  };
  SpeechSynthesisUtterance?: new (text: string) => UtteranceLike;
}

const isGerman = (voice: VoiceLike): boolean =>
  voice.lang.toLowerCase().replace('_', '-').startsWith('de');

// An empty voice list means the browser has not loaded its voices yet: the
// utterance still asks for de-DE. A list without any German voice is a
// controlled fallback, never another language.
export const speakGerman = (
  word: string,
  environment: SpeechEnvironment = globalThis as SpeechEnvironment,
): SpeechResult => {
  const synthesis = environment.speechSynthesis;
  const Utterance = environment.SpeechSynthesisUtterance;
  if (!synthesis || !Utterance) return 'unavailable';
  let voices: readonly VoiceLike[];
  try {
    voices = synthesis.getVoices();
  } catch {
    return 'unavailable';
  }
  const german =
    voices.find((voice) => voice.lang === GERMAN_SPEECH_LANG) ??
    voices.find(isGerman) ??
    null;
  if (voices.length > 0 && !german) return 'no-german-voice';
  try {
    const utterance = new Utterance(word);
    utterance.lang = GERMAN_SPEECH_LANG;
    if (german) utterance.voice = german;
    utterance.rate = 0.9;
    synthesis.cancel();
    synthesis.speak(utterance as never);
    return 'started';
  } catch {
    return 'unavailable';
  }
};
