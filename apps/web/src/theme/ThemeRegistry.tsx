'use client';

import type { ReactNode } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider, createTheme } from '@mui/material/styles';

const PRIMARY = '#1d4ed8';

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
  },
});

export const ThemeRegistry = ({ children }: { children: ReactNode }) => (
  <ThemeProvider theme={theme}>
    <CssBaseline />
    {children}
  </ThemeProvider>
);
