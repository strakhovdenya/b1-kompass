import { getTranslations } from 'next-intl/server';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { continueAsGuest } from '../server/next/actions';

interface HomePageProps {
  searchParams: Promise<{ busy?: string | string[] }>;
}

const HomePage = async ({ searchParams }: HomePageProps) => {
  const t = await getTranslations();
  const { busy } = await searchParams;
  const isBusy = busy === '1';

  return (
    <Stack spacing={3} component="section">
      <Typography component="h1" variant="h4">
        {t('home.title')}
      </Typography>
      <Typography>{t('app.tagline')}</Typography>
      <Typography>{t('home.description')}</Typography>
      {isBusy && <Alert severity="info">{t('home.busy')}</Alert>}
      <form action={continueAsGuest}>
        <Button type="submit" variant="contained" size="large">
          {t('home.continue')}
        </Button>
      </form>
      <Typography variant="body2" color="text.secondary">
        {t('home.note')}
      </Typography>
    </Stack>
  );
};

export default HomePage;
