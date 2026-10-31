'use client';

import { useLocale, useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type {
  AttemptReview,
  DtzLevel,
  ExamQuestion,
  QuestionOutcome,
  ReviewItem,
} from '@b1k/domain';

export type ReviewBlock = 'hoeren' | 'lesen';

interface AttemptReviewViewProps {
  review: AttemptReview;
  questions: readonly ExamQuestion[];
  // Only the tasks of this block are listed; the totals are always shown.
  block?: ReviewBlock;
}

const LEVEL_KEY: Readonly<Record<DtzLevel, string>> = {
  'below-A2': 'belowA2',
  A2: 'a2',
  B1: 'b1',
};

// The stored percent has one decimal; only its notation follows the locale.
const formatPercent = (locale: string, percent: number): string =>
  new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(percent / 100);

const OUTCOME_MARK: Readonly<Record<QuestionOutcome, string>> = {
  correct: '✓',
  incorrect: '✗',
  skipped: '–',
};

// Message keys avoid the word of the review data: the messages are part of
// every page, and the page of an active attempt must not mention keys.
const OUTCOME_LABEL: Readonly<Record<QuestionOutcome, string>> = {
  correct: 'right',
  incorrect: 'wrong',
  skipped: 'skipped',
};

const OUTCOME_COLOR: Readonly<Record<QuestionOutcome, string>> = {
  correct: 'success.main',
  incorrect: 'error.main',
  skipped: 'text.secondary',
};

const optionText = (question: ExamQuestion, optionId: string): string =>
  question.options.find((option) => option.id === optionId)?.text ?? '';

// Server result of a completed attempt, shown as stored. The full exam shows
// the totals per skill and the level; the short set gets points and the
// per-task review only, an official level is never shown for it.
export const AttemptReviewView = ({
  review,
  questions,
  block,
}: AttemptReviewViewProps) => {
  const t = useTranslations('results');
  const locale = useLocale();
  const { skills } = review;
  const byId = new Map(questions.map((question) => [question.id, question]));

  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby="result-title"
      data-testid="attempt-review"
      sx={{ p: { xs: 2, sm: 3 } }}
    >
      <Stack spacing={2}>
        <Typography id="result-title" component="h2" variant="h6">
          {t('title')}
        </Typography>
        <Typography variant="h5" component="p" data-testid="result-score">
          {t('score', {
            score: review.score,
            maxScore: review.maxScore,
            percent: formatPercent(locale, review.percent),
          })}
        </Typography>
        {skills ? (
          <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 0 }}>
            {(['hoeren', 'lesen'] as const).map((skill) => {
              const { score, maxScore } = skills[skill];
              return (
                <Typography
                  key={skill}
                  component="li"
                  sx={{ listStyle: 'none' }}
                  data-testid={`result-${skill}`}
                >
                  {t(`skill.${skill}`, { score, maxScore })}
                </Typography>
              );
            })}
          </Stack>
        ) : null}
        {review.level ? (
          <Typography data-testid="result-level" sx={{ fontWeight: 600 }}>
            {t('level', { level: t(`levelName.${LEVEL_KEY[review.level]}`) })}
          </Typography>
        ) : null}
        <Typography data-testid="result-counts">
          {t('counts', {
            right: review.correct,
            wrong: review.incorrect,
            skipped: review.skipped,
          })}
        </Typography>
        {review.showsLevel ? null : (
          <Alert severity="info" data-testid="result-scope">
            {t('noLevel')}
          </Alert>
        )}
        <Divider />
        <Stack
          component="ol"
          spacing={2}
          sx={{ m: 0, pl: 0, listStyle: 'none' }}
        >
          {review.items.map((item) => {
            const question = byId.get(item.questionId);
            const isShown = question && (!block || question.skill === block);
            return question && isShown ? (
              <ReviewEntry
                key={item.questionId}
                item={item}
                question={question}
              />
            ) : null;
          })}
        </Stack>
      </Stack>
    </Paper>
  );
};

interface ReviewEntryProps {
  item: ReviewItem;
  question: ExamQuestion;
}

const ReviewEntry = ({ item, question }: ReviewEntryProps) => {
  const t = useTranslations('results');
  const selected = item.selectedOptionId;
  return (
    <li
      data-testid="review-item"
      data-question-id={item.questionId}
      data-outcome={item.outcome}
    >
      <Stack spacing={0.5}>
        <Typography component="h3" variant="subtitle1" lang="de">
          {question.number}. {question.prompt}
        </Typography>
        <Typography
          variant="body2"
          color={OUTCOME_COLOR[item.outcome]}
          sx={{ fontWeight: 600 }}
        >
          {OUTCOME_MARK[item.outcome]}{' '}
          {t(`outcome.${OUTCOME_LABEL[item.outcome]}`)}
        </Typography>
        <Typography variant="body2">
          {t('yourAnswer')}{' '}
          {selected === null ? (
            t('noAnswer')
          ) : (
            <span lang="de">
              <strong>{selected}</strong> {optionText(question, selected)}
            </span>
          )}
        </Typography>
        <Typography variant="body2" data-testid="review-solution">
          {t('solution')}{' '}
          <span lang="de">
            <strong>{item.correctOptionId}</strong>{' '}
            {optionText(question, item.correctOptionId)}
          </span>
        </Typography>
      </Stack>
    </li>
  );
};
