// Saved answers of one attempt: question id -> option id, one per question.
export type Selections = Readonly<Record<string, string>>;

export type SaveAnswerError =
  | 'invalid-input'
  | 'session-invalid'
  | 'attempt-not-found'
  | 'option-not-allowed'
  | 'unavailable';

// Contract between the save operation of the server and the answer UI.
export type SaveAnswerResult =
  | { ok: true; questionId: string; optionId: string; savedAt: string }
  | { ok: false; error: SaveAnswerError };
