'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

// The public card of one exam: names and counts only.
export interface LibraryEntry {
  slug: string;
  title: string;
  format: string;
  hoerenCount: number;
  lesenCount: number;
  totalCount: number;
  // The guest's own next steps; null when there is none.
  continueHref?: string | null;
  resultHref?: string | null;
}

interface ExamLibraryProps {
  entries: readonly LibraryEntry[];
  hasError?: boolean;
}

const actionSx = {
  minHeight: 48,
  width: { xs: '100%', sm: 'auto' },
  minWidth: 0,
  whiteSpace: 'normal',
  textAlign: 'center',
} as const;

const ExamCard = ({ entry }: { entry: LibraryEntry }) => {
  const t = useTranslations('library');
  return (
    <Paper
      component="li"
      variant="outlined"
      data-testid={`exam-card-${entry.slug}`}
      sx={{ p: { xs: 2, sm: 2.5 }, borderRadius: 2, minWidth: 0 }}
    >
      <Stack spacing={1.5}>
        <Typography
          component="h2"
          variant="h6"
          data-testid="exam-card-title"
          sx={{ overflowWrap: 'anywhere' }}
        >
          {entry.title}
        </Typography>
        <Typography color="text.secondary" data-testid="exam-card-counts">
          {t('counts', {
            format: entry.format,
            hoeren: entry.hoerenCount,
            lesen: entry.lesenCount,
            total: entry.totalCount,
          })}
        </Typography>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          useFlexGap
          sx={{ flexWrap: 'wrap', minWidth: 0 }}
        >
          {entry.continueHref ? (
            <Button
              component={Link}
              href={entry.continueHref}
              variant="contained"
              data-testid="exam-card-continue"
              sx={actionSx}
            >
              {t('continue')}
            </Button>
          ) : (
            <Button
              component={Link}
              href={`/practice/${entry.slug}`}
              variant="contained"
              data-testid="exam-card-open"
              sx={actionSx}
            >
              {t('choose')}
            </Button>
          )}
          {entry.resultHref ? (
            <Button
              component={Link}
              href={entry.resultHref}
              variant="outlined"
              data-testid="exam-card-result"
              sx={actionSx}
            >
              {t('latestResult')}
            </Button>
          ) : null}
        </Stack>
      </Stack>
    </Paper>
  );
};

export const ExamLibrary = ({
  entries,
  hasError = false,
}: ExamLibraryProps) => {
  const t = useTranslations('library');
  const isEmpty = !hasError && entries.length === 0;
  return (
    <Stack component="section" spacing={2.5} data-testid="exam-library">
      <Typography component="h1" variant="h4" sx={{ overflowWrap: 'anywhere' }}>
        {t('title')}
      </Typography>
      {hasError ? (
        <Alert
          severity="error"
          role="alert"
          data-testid="library-error"
          action={
            <Button color="inherit" size="small" component={Link} href="/exams">
              {t('retry')}
            </Button>
          }
        >
          {t('error')}
        </Alert>
      ) : null}
      {isEmpty ? (
        <Alert severity="info" role="status" data-testid="library-empty">
          {t('empty')}
        </Alert>
      ) : null}
      {!hasError && !isEmpty ? (
        <Stack
          component="ul"
          spacing={2}
          data-testid="exam-list"
          sx={{ listStyle: 'none', p: 0, m: 0 }}
        >
          {entries.map((entry) => (
            <ExamCard key={entry.slug} entry={entry} />
          ))}
        </Stack>
      ) : null}
      {hasError || isEmpty ? (
        <Button
          component={Link}
          href="/"
          variant="outlined"
          data-testid="library-home"
          sx={{ minHeight: 48, alignSelf: 'flex-start' }}
        >
          {t('home')}
        </Button>
      ) : null}
    </Stack>
  );
};
