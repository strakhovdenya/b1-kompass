'use client';

import { useTranslations } from 'next-intl';
import IconButton from '@mui/material/IconButton';
import SvgIcon from '@mui/material/SvgIcon';
import Tooltip from '@mui/material/Tooltip';
import { useTheme } from '@mui/material/styles';

// The "translate" glyph of Material Icons (Apache 2.0), drawn here so that no
// icon package is added.
const TRANSLATE_PATH =
  'M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z';

interface DictionaryHeaderToggleProps {
  isOn: boolean;
  onToggle: () => void;
}

// The one control of the translator, in the header of a training page. Off is
// drawn with a slash across the glyph, so the state is not only a colour.
export const DictionaryHeaderToggle = ({
  isOn,
  onToggle,
}: DictionaryHeaderToggleProps) => {
  const t = useTranslations('dictionary');
  const { palette } = useTheme();
  return (
    <Tooltip title={isOn ? t('tooltipOn') : t('tooltipOff')}>
      <IconButton
        color="inherit"
        aria-label={t('toggle')}
        aria-pressed={isOn}
        data-testid="dictionary-toggle"
        data-enabled={isOn}
        onClick={onToggle}
        sx={{
          width: 48,
          height: 48,
          bgcolor: isOn ? 'rgba(255, 255, 255, 0.22)' : 'transparent',
          '&:hover': { bgcolor: 'rgba(255, 255, 255, 0.32)' },
          // The theme ring is blue, like the header: here it is white.
          '&.Mui-focusVisible': { outline: '3px solid #fff', outlineOffset: 0 },
        }}
      >
        <SvgIcon>
          <path d={TRANSLATE_PATH} opacity={isOn ? 1 : 0.7} />
          {isOn ? null : (
            <>
              <path
                d="M3 3 L21 21"
                stroke={palette.primary.main}
                strokeWidth="4.5"
                fill="none"
              />
              <path
                d="M3 3 L21 21"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
              />
            </>
          )}
        </SvgIcon>
      </IconButton>
    </Tooltip>
  );
};
