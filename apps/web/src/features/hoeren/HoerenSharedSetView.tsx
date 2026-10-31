import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ExamGroup, ExamQuestion } from '@b1k/domain';

interface HoerenSharedSetViewProps {
  group: ExamGroup;
  questions: readonly ExamQuestion[];
  cards: ReactNode[];
}

const optionKey = (options: readonly { id: string; text: string }[]): string =>
  options
    .map((option) => `${option.id}:${option.text}`)
    .sort()
    .join('|');

// The group fits the material when it has options, every member is in the
// material and each member carries exactly the options of the group.
const isUsable = (
  group: ExamGroup,
  questions: readonly ExamQuestion[],
): boolean => {
  if (group.kind !== 'shared-set') return false;
  if (group.options.length === 0) return false;
  if (questions.length !== group.questionIds.length) return false;
  const pool = optionKey(group.options);
  return questions.every((question) => optionKey(question.options) === pool);
};

// Teil 4: one long recording and one common list of statements. Every card
// keeps the whole list, so a choice in one question never narrows the others;
// each question is still saved and scored alone. A group that does not fit
// the material is reported and no other list is shown in its place.
export const HoerenSharedSetView = ({
  group,
  questions,
  cards,
}: HoerenSharedSetViewProps) => {
  const t = useTranslations('hoeren');
  if (!isUsable(group, questions)) {
    return (
      <Alert severity="error" role="alert" data-testid={`shared-${group.id}`}>
        {t('sharedSetError')}
      </Alert>
    );
  }
  const first = questions[0];
  const last = questions[questions.length - 1];
  return (
    <Box
      component="fieldset"
      data-testid={`shared-${group.id}`}
      sx={{ border: 0, m: 0, p: 0, minWidth: 0 }}
    >
      <Typography component="legend" variant="body2" color="text.secondary">
        {t('sharedSetLegend', {
          first: first?.number ?? '',
          last: last?.number ?? '',
        })}
      </Typography>
      <Stack spacing={2} sx={{ mt: 1 }}>
        {cards}
      </Stack>
    </Box>
  );
};
