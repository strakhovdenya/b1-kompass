'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ClickAwayListener from '@mui/material/ClickAwayListener';
import Drawer from '@mui/material/Drawer';
import Paper from '@mui/material/Paper';
import Popper from '@mui/material/Popper';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { isLocale } from '@b1k/domain';
import { requestDictionaryEntry } from './client';
import { DictionaryCard } from './DictionaryCard';
import { wordAtPoint, wordOfCurrentSelection, zoneOf } from './dom';
import type { WordHit } from './dom';
import type { DictionaryEntry, PartState } from './entry';
import { DictionaryActiveContext } from './GermanText';
import { CLOSED, createLookupController } from './lookup';
import type { LookupAnswer, LookupController, LookupState } from './lookup';
import { useDictionarySetting } from './settings';

// The dictionary of one training page. It wraps the German text zones
// (GermanText), owns the switch, the lookup and the card, and never touches
// answers, audio, the reading position or the material:
// - desktop: a non-modal Popper beside the word after a 500 ms hover, a
//   double click or the selection of one word; it stays while the pointer is
//   on it and closes on Escape, a click outside or the close button;
// - phone: a tap on a word or the selection of one word opens a bottom
//   sheet (a persistent Drawer, no scroll lock); the system selection stays;
// - keyboard and screen readers: one button translates the selected word,
//   focus moves into the card and returns to the button on close.

export const HOVER_DELAY_MS = 500;
const SELECTION_DELAY_MS = 600;
const MAX_REMEMBERED = 200;

type Presentation = 'popper' | 'sheet';

interface Opened {
  word: string;
  range: Range | null;
  presentation: Presentation;
  returnFocus: HTMLElement | null;
  boundary: Element | null;
}

interface VirtualAnchor {
  getBoundingClientRect: () => DOMRect;
  contextElement?: Element;
}

const anchorOf = (opened: Opened): VirtualAnchor => {
  const { range, boundary: fallback } = opened;
  return {
    getBoundingClientRect: () =>
      range?.getBoundingClientRect() ??
      fallback?.getBoundingClientRect() ??
      new DOMRect(),
    contextElement: fallback ?? undefined,
  };
};

const POPPER_MODIFIERS = [
  { name: 'offset', options: { offset: [0, 8] } },
  { name: 'flip', enabled: true },
  { name: 'preventOverflow', options: { padding: 8, altAxis: true } },
];

const SETTLED: readonly PartState[] = ['found', 'not-found'];

const isSettled = (entry: DictionaryEntry): boolean =>
  SETTLED.includes(entry.translation.state) &&
  SETTLED.includes(entry.lexical.state);

interface DictionaryBoundaryProps {
  children: ReactNode;
}

export const DictionaryBoundary = ({ children }: DictionaryBoundaryProps) => {
  const t = useTranslations('dictionary');
  const locale = useLocale();
  const target = isLocale(locale) ? locale : 'en';
  const [enabled, setEnabled] = useDictionarySetting();
  const [state, setState] = useState<LookupState>(CLOSED);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [notice, setNotice] = useState(false);
  const isCoarse = useMediaQuery('(pointer: coarse)', { noSsr: true });
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const openedRef = useRef<Opened | null>(null);
  const remembered = useRef(new Map<string, DictionaryEntry>());
  const localeRef = useRef(target);
  const controllerRef = useRef<LookupController | null>(null);

  useEffect(() => {
    localeRef.current = target;
  }, [target]);

  const lookup = useCallback(async (word: string, signal: AbortSignal) => {
    const key = `${localeRef.current}:${word}`;
    const known = remembered.current.get(key);
    if (known) return { ok: true, entry: known } as LookupAnswer;
    const answer = await requestDictionaryEntry(word, signal);
    // Only a settled answer is remembered, under the language the server
    // actually used: a failure or a used-up limit is asked again next time.
    if (answer.ok && isSettled(answer.entry)) {
      const cache = remembered.current;
      if (cache.size >= MAX_REMEMBERED) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(`${answer.entry.target}:${word}`, answer.entry);
    }
    return answer;
  }, []);

  const controllerOf = useCallback((): LookupController => {
    controllerRef.current ??= createLookupController(lookup, setState);
    return controllerRef.current;
  }, [lookup]);

  const openWord = useCallback(
    (
      hit: WordHit,
      presentation: Presentation,
      returnFocus: HTMLElement | null,
    ) => {
      const current = openedRef.current;
      const isSame =
        current !== null &&
        current.word === hit.word &&
        current.presentation === presentation &&
        controllerOf().current().status !== 'closed' &&
        controllerOf().current().status !== 'error';
      if (isSame) return;
      const next = {
        word: hit.word,
        range: hit.range,
        presentation,
        returnFocus,
        boundary: rootRef.current,
      };
      openedRef.current = next;
      setOpened(next);
      setNotice(false);
      controllerOf().open(hit.word);
    },
    [controllerOf],
  );

  const close = useCallback(() => {
    const current = openedRef.current;
    openedRef.current = null;
    controllerOf().close();
    setOpened(null);
    current?.returnFocus?.focus();
  }, [controllerOf]);

  // A synonym is a new lookup of its own word in the same place.
  const lookUpSynonym = useCallback(
    (word: string) => {
      const current = openedRef.current;
      if (!current) return;
      const next = { ...current, word };
      openedRef.current = next;
      setOpened(next);
      controllerOf().open(word);
    },
    [controllerOf],
  );

  // Switching the translator off stops any lookup and closes the card.
  const changeEnabled = (next: boolean) => {
    setEnabled(next);
    if (next) return;
    openedRef.current = null;
    controllerOf().close();
    setOpened(null);
    setNotice(false);
  };

  useEffect(() => () => controllerRef.current?.close(), []);

  // The pointer and selection listeners exist only while the translator is
  // on. They are native listeners of the boundary, so events inside the
  // card (a portal) never start a new lookup.
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    let hoverTimer = 0;
    let selectionTimer = 0;
    let pointerType = 'mouse';

    const clearHover = () => window.clearTimeout(hoverTimer);

    const handlePointerDown = (event: PointerEvent) => {
      pointerType = event.pointerType;
      clearHover();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.buttons !== 0) return;
      clearHover();
      if (!zoneOf(event.target as Node, root)) return;
      const { clientX, clientY } = event;
      hoverTimer = window.setTimeout(() => {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return;
        const hit = wordAtPoint(clientX, clientY, root);
        if (hit) openWord(hit, 'popper', null);
      }, HOVER_DELAY_MS);
    };

    const handleMouseUp = () => {
      if (pointerType !== 'mouse') return;
      window.setTimeout(() => {
        const hit = wordOfCurrentSelection(root);
        if (hit) openWord(hit, 'popper', null);
      }, 0);
    };

    const handleClick = (event: MouseEvent) => {
      if (pointerType === 'mouse') return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const hit = wordAtPoint(event.clientX, event.clientY, root);
      if (hit) openWord(hit, 'sheet', null);
    };

    // A word selected on a touch screen (long press) opens the sheet once
    // the selection has settled.
    const handleSelectionChange = () => {
      if (pointerType === 'mouse') return;
      window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(() => {
        const hit = wordOfCurrentSelection(root);
        if (hit) openWord(hit, 'sheet', null);
      }, SELECTION_DELAY_MS);
    };

    root.addEventListener('pointerdown', handlePointerDown);
    root.addEventListener('pointermove', handlePointerMove);
    root.addEventListener('pointerleave', clearHover);
    root.addEventListener('mouseup', handleMouseUp);
    root.addEventListener('click', handleClick);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      clearHover();
      window.clearTimeout(selectionTimer);
      root.removeEventListener('pointerdown', handlePointerDown);
      root.removeEventListener('pointermove', handlePointerMove);
      root.removeEventListener('pointerleave', clearHover);
      root.removeEventListener('mouseup', handleMouseUp);
      root.removeEventListener('click', handleClick);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [enabled, openWord]);

  const isOpen = opened !== null;
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, close]);

  const translateSelection = () => {
    const root = rootRef.current;
    const hit = root ? wordOfCurrentSelection(root) : null;
    if (!hit) {
      setNotice(true);
      return;
    }
    openWord(hit, isCoarse ? 'sheet' : 'popper', buttonRef.current);
  };

  // A click on another German word is handled by the boundary itself.
  const handleClickAway = (event: MouseEvent | TouchEvent) => {
    const root = rootRef.current;
    const node = event.target as Node | null;
    if (root && zoneOf(node, root)) return;
    if (node && buttonRef.current?.contains(node)) return;
    close();
  };

  const anchor = useMemo(() => (opened ? anchorOf(opened) : null), [opened]);
  // A translator switched off in another tab hides the card here as well.
  const card =
    enabled && opened && state.status !== 'closed' ? (
      <DictionaryCard
        state={state}
        target={target}
        titleId={titleId}
        shouldFocusTitle={Boolean(opened.returnFocus)}
        onClose={close}
        onLookup={lookUpSynonym}
      />
    ) : null;

  return (
    <DictionaryActiveContext.Provider value={enabled}>
      <Stack spacing={2}>
        <Paper
          variant="outlined"
          data-testid="dictionary-bar"
          data-enabled={enabled}
          sx={{ px: 2, py: 1 }}
        >
          <Stack
            direction="row"
            useFlexGap
            sx={{ alignItems: 'center', flexWrap: 'wrap', columnGap: 2 }}
          >
            {/* A pressed button, not a checkbox: the page's only checked
                inputs stay the answers. */}
            <ToggleButton
              value="dictionary"
              size="small"
              color="primary"
              selected={enabled}
              data-testid="dictionary-toggle"
              onChange={() => changeEnabled(!enabled)}
              sx={{ minHeight: 40, textTransform: 'none', gap: 1 }}
            >
              {t('toggle')}
              <Box component="span" sx={{ fontWeight: 700 }}>
                {enabled ? t('stateOn') : t('stateOff')}
              </Box>
            </ToggleButton>
            {enabled ? (
              <Button
                ref={buttonRef}
                size="small"
                variant="outlined"
                data-testid="dictionary-translate-selection"
                onMouseDown={(event) => event.preventDefault()}
                onClick={translateSelection}
                sx={{ minHeight: 40 }}
              >
                {t('translateSelection')}
              </Button>
            ) : null}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {enabled ? t('hint') : t('off')}
          </Typography>
          {notice ? (
            <Typography
              role="status"
              variant="body2"
              data-testid="dictionary-selection-notice"
            >
              {t('selectOneWord')}
            </Typography>
          ) : null}
        </Paper>
        <Box ref={rootRef} data-testid="dictionary-boundary">
          {children}
        </Box>
      </Stack>
      {card && anchor && opened?.presentation === 'popper' ? (
        <Popper
          open
          anchorEl={anchor}
          placement="bottom-start"
          modifiers={POPPER_MODIFIERS}
          sx={{ zIndex: 'modal' }}
        >
          <ClickAwayListener onClickAway={handleClickAway}>
            <Paper
              elevation={8}
              role="dialog"
              aria-modal="false"
              aria-labelledby={titleId}
              data-testid="dictionary-card"
              data-presentation="popper"
              sx={{
                p: 2,
                width: 'min(360px, calc(100vw - 16px))',
                maxHeight: '60vh',
                overflowY: 'auto',
              }}
            >
              {card}
            </Paper>
          </ClickAwayListener>
        </Popper>
      ) : null}
      {card && opened?.presentation === 'sheet' ? (
        <Drawer
          anchor="bottom"
          variant="persistent"
          open
          slotProps={{
            paper: {
              sx: {
                maxHeight: '70vh',
                borderTopLeftRadius: 16,
                borderTopRightRadius: 16,
              },
            },
          }}
        >
          <ClickAwayListener onClickAway={handleClickAway}>
            <Box
              role="dialog"
              aria-modal="false"
              aria-labelledby={titleId}
              data-testid="dictionary-card"
              data-presentation="sheet"
              sx={{
                p: 2,
                pb: 'calc(16px + env(safe-area-inset-bottom))',
                overflowY: 'auto',
              }}
            >
              {card}
            </Box>
          </ClickAwayListener>
        </Drawer>
      ) : null}
    </DictionaryActiveContext.Provider>
  );
};
