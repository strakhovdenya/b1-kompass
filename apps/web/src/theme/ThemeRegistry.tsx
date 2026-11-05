'use client';

import type { CSSProperties, ReactNode } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider, createTheme } from '@mui/material/styles';

const PRIMARY = '#1d4ed8';

// Typography of the German learning content. The sizes are rem, so they grow
// with the text size of the browser; the German zones may hyphenate and wrap
// long compounds for display only (the material itself is never changed).
declare module '@mui/material/styles' {
  interface TypographyVariants {
    lesenBody: CSSProperties;
    readingTitle: CSSProperties;
    taskPrompt: CSSProperties;
    answerOption: CSSProperties;
  }
  interface TypographyVariantsOptions {
    lesenBody?: CSSProperties;
    readingTitle?: CSSProperties;
    taskPrompt?: CSSProperties;
    answerOption?: CSSProperties;
  }
}

declare module '@mui/material/Typography' {
  interface TypographyPropsVariantOverrides {
    lesenBody: true;
    readingTitle: true;
    taskPrompt: true;
    answerOption: true;
  }
}

const GERMAN_WRAP = {
  hyphens: 'auto',
  overflowWrap: 'break-word',
  minWidth: 0,
} satisfies CSSProperties;

// A keyboard user always sees where the focus is: a solid ring around the
// control, not only the faint ripple of MUI. The ring of a radio or a slider
// is drawn around its control, the input itself is invisible.
const FOCUS_RING = { outline: `3px solid ${PRIMARY}`, outlineOffset: 2 };

const theme = createTheme({
  components: {
    MuiCssBaseline: { styleOverrides: { ':focus-visible': FOCUS_RING } },
    MuiButtonBase: {
      styleOverrides: { root: { '&.Mui-focusVisible': FOCUS_RING } },
    },
    MuiSlider: {
      styleOverrides: { thumb: { '&.Mui-focusVisible': FOCUS_RING } },
    },
  },
  palette: {
    primary: { main: PRIMARY },
    secondary: { main: '#0f766e' },
    background: { default: '#f5f8ff' },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    button: { textTransform: 'none', fontWeight: 600 },
    lesenBody: {
      ...GERMAN_WRAP,
      fontSize: '1.125rem',
      lineHeight: 1.6,
    },
    readingTitle: {
      ...GERMAN_WRAP,
      fontSize: '1.3125rem',
      fontWeight: 600,
      lineHeight: 1.4,
    },
    taskPrompt: {
      ...GERMAN_WRAP,
      fontSize: '1.25rem',
      fontWeight: 600,
      lineHeight: 1.5,
    },
    answerOption: {
      ...GERMAN_WRAP,
      fontSize: '1.125rem',
      lineHeight: 1.5,
    },
  },
});

export const ThemeRegistry = ({ children }: { children: ReactNode }) => (
  <ThemeProvider theme={theme}>
    <CssBaseline />
    {children}
  </ThemeProvider>
);
