'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

// Route-level boundary: never shows the raw error to the visitor.
const ErrorPage = ({ error, reset }: ErrorPageProps) => {
  const t = useTranslations('error');

  useEffect(() => {
    console.error({ error });
  }, [error]);

  return (
    <Alert
      severity="error"
      role="alert"
      action={
        <Button color="inherit" size="small" onClick={reset}>
          {t('retry')}
        </Button>
      }
    >
      {t('message')}
    </Alert>
  );
};

export default ErrorPage;
