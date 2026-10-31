// Saved answers of one attempt: question id -> option id, one per question.
export type Selections = Readonly<Record<string, string>>;

export type SaveAnswerError =
  | 'invalid-input'
  | 'session-invalid'
  | 'attempt-not-found'
  | 'option-not-allowed'
  | 'unavailable';

// Contract between the save operation of the server and the answer UI. A
// save carries the revision of the choice: the order of the changes of one
// answer. 'stale' means the server stored a newer revision, 'conflict' the
// same revision with another option; nothing was written and the stored
// answer is returned, so the next choice can be sent above its revision.
export type SaveAnswerResult =
  | {
      ok: true;
      questionId: string;
      optionId: string;
      revision: number;
      savedAt: string;
    }
  | {
      ok: false;
      error: 'stale' | 'conflict';
      optionId: string;
      revision: number;
    }
  | { ok: false; error: SaveAnswerError };
