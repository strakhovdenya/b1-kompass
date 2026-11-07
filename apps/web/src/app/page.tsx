import { getTranslations } from 'next-intl/server';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { continueAsGuest } from '../server/next/actions';

interface HomePageProps {
  searchParams: Promise<{ busy?: string | string[] }>;
}

const SKILLS = ['hoeren', 'lesen'] as const;

const HomePage = async ({ searchParams }: HomePageProps) => {
  const t = await getTranslations();
  const { busy } = await searchParams;
  const isBusy = busy === '1';

  return (
    <Stack
      component="section"
      spacing={2.5}
      data-testid="guest-entry"
      sx={{ maxWidth: 720, mx: 'auto' }}
    >
      <Paper
        variant="outlined"
        sx={{ p: { xs: 2.5, sm: 4 }, borderRadius: 2, minWidth: 0 }}
      >
        <Stack spacing={2.5}>
          <Stack spacing={1}>
            <Typography
              component="h1"
              variant="h4"
              sx={{ overflowWrap: 'anywhere' }}
            >
              {t('home.title')}
            </Typography>
            <Typography color="text.secondary">{t('app.tagline')}</Typography>
            <Typography>{t('home.description')}</Typography>
          </Stack>
          <Stack
            spacing={2}
            sx={{ flexDirection: { xs: 'column', sm: 'row' } }}
            data-testid="home-skills"
          >
            {SKILLS.map((skill) => (
              <Box key={skill} sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  component="h2"
                  variant="subtitle1"
                  sx={{ fontWeight: 600 }}
                >
                  {t(`home.${skill}.title`)}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t(`home.${skill}.text`)}
                </Typography>
              </Box>
            ))}
          </Stack>
          {isBusy ? (
            <Alert severity="info" data-testid="home-busy">
              {t('home.busy')}
            </Alert>
          ) : null}
          <form action={continueAsGuest}>
            <Button
              type="submit"
              variant="contained"
              size="large"
              data-testid="guest-continue"
              sx={{
                minHeight: 48,
                width: { xs: '100%', sm: 'auto' },
                px: 4,
              }}
            >
              {t('home.continue')}
            </Button>
          </form>
        </Stack>
      </Paper>
      <Box data-testid="guest-note" sx={{ px: { xs: 0.5, sm: 1 } }}>
        <Typography component="h2" variant="subtitle2" sx={{ fontWeight: 600 }}>
          {t('home.guestTitle')}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t('home.note')}
        </Typography>
      </Box>
    </Stack>
  );
};

export default HomePage;
