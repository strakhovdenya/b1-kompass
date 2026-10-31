import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v16-appRouter';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { LocaleSwitcher } from '../features/locale/LocaleSwitcher';
import { setLocaleAction } from '../server/next/actions';
import { getCurrentGuest } from '../server/next/request';
import { ThemeRegistry } from '../theme/ThemeRegistry';

export const metadata: Metadata = {
  title: 'B1 Kompass',
  description: 'German A2–B1 practice: DTZ Hören and Lesen',
};

const RootLayout = async ({ children }: { children: ReactNode }) => {
  const locale = await getLocale();
  const t = await getTranslations('app');
  const guest = await getCurrentGuest();

  return (
    <html lang={locale}>
      <body>
        <AppRouterCacheProvider>
          <NextIntlClientProvider>
            <ThemeRegistry>
              <AppBar position="static" elevation={0}>
                <Toolbar sx={{ gap: 2, flexWrap: 'wrap', py: 1 }}>
                  <Typography component="p" variant="h6" sx={{ flexGrow: 1 }}>
                    {t('name')}
                  </Typography>
                  {guest ? (
                    <Box sx={{ bgcolor: 'common.white', borderRadius: 1 }}>
                      <LocaleSwitcher changeLocale={setLocaleAction} />
                    </Box>
                  ) : null}
                </Toolbar>
              </AppBar>
              <Container component="main" maxWidth="md" sx={{ py: 4 }}>
                {children}
              </Container>
            </ThemeRegistry>
          </NextIntlClientProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
};

export default RootLayout;
