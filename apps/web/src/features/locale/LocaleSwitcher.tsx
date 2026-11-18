'use client';

import { useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { LOCALES } from '@b1k/domain';

interface LocaleSwitcherProps {
  changeLocale: (locale: string) => Promise<boolean>;
}

export const LocaleSwitcher = ({ changeLocale }: LocaleSwitcherProps) => {
  const t = useTranslations('locale');
  const locale = useLocale();
  const [isPending, startTransition] = useTransition();

  const handleChange = (_event: unknown, next: string | null) => {
    if (!next || next === locale) return;
    // The action revalidates the layout itself; a failure keeps the current
    // language instead of replacing the page with an error screen.
    startTransition(async () => {
      try {
        await changeLocale(next);
      } catch (error) {
        console.error({ error });
      }
    });
  };

  return (
    <ToggleButtonGroup
      exclusive
      value={locale}
      onChange={handleChange}
      aria-label={t('label')}
      disabled={isPending}
    >
      {LOCALES.map((item) => (
        <ToggleButton
          key={item}
          value={item}
          lang={item}
          aria-label={t(item)}
          data-testid={`locale-${item}`}
          sx={{
            minWidth: 48,
            minHeight: 44,
            px: 1,
            fontWeight: 700,
            // The switch sits on a white plate in the blue header: the theme
            // ring (blue, outside the button) would melt into the header
            // there. The ring is drawn inside the button, on the plate.
            '&.Mui-focusVisible': {
              outline: (theme) => `3px solid ${theme.palette.primary.dark}`,
              outlineOffset: '-3px',
              zIndex: 1,
            },
          }}
        >
          {t(`short.${item}`)}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
};
