import { getTranslations } from 'next-intl/server';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { continueAsGuest } from '../server/next/actions';

const HomePage = async () => {
  const t = await getTranslations();

  return (
    <Stack spacing={3} component="section">
      <Typography component="h1" variant="h4">
        {t('home.title')}
      </Typography>
      <Typography>{t('app.tagline')}</Typography>
      <Typography>{t('home.description')}</Typography>
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
