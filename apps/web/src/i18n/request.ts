import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE } from '@b1k/domain';
import { getCurrentGuest } from '../server/next/request';

// The interface language belongs to the guest session only. Accept-Language,
// NEXT_LOCALE and earlier sessions are deliberately ignored.
export default getRequestConfig(async () => {
  const guest = await getCurrentGuest();
  const locale = guest?.locale ?? DEFAULT_LOCALE;
  const messages = (await import(`../../messages/${locale}.json`)).default;
  return { locale, messages };
});
