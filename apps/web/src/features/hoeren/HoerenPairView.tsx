import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { ExamQuestion } from '@b1k/domain';

interface HoerenPairViewProps {
  groupId: string;
  questions: readonly ExamQuestion[];
  cards: ReactNode[];
}

// Teil 3: the two questions of one conversation next to each other, side by
// side on a wide screen and stacked on a narrow one. The cards stay the
// ordinary single-choice cards: each question is saved and scored alone.
export const HoerenPairView = ({
  groupId,
  questions,
  cards,
}: HoerenPairViewProps) => {
  const t = useTranslations('hoeren');
  const [first, second] = questions;
  return (
    <Box
      component="fieldset"
      data-testid={`pair-${groupId}`}
      sx={{ border: 0, m: 0, p: 0, minWidth: 0 }}
    >
      <Typography component="legend" variant="body2" color="text.secondary">
        {t('pairLegend', {
          first: first?.number ?? '',
          second: second?.number ?? '',
        })}
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          mt: 1,
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' },
        }}
      >
        {cards}
      </Box>
    </Box>
  );
};
