'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocale, useTranslations } from 'next-intl';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ClickAwayListener from '@mui/material/ClickAwayListener';
import Drawer from '@mui/material/Drawer';
import Paper from '@mui/material/Paper';
import Popper from '@mui/material/Popper';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { isLocale } from '@b1k/domain';
import { requestDictionaryEntry } from './client';
import { DictionaryCard } from './DictionaryCard';
import { DictionaryHeaderToggle } from './DictionaryHeaderToggle';
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
// - phone: holding a finger still on a word for 1500 ms opens a bottom sheet
//   (a persistent Drawer, no scroll lock); a tap, a scroll or a moving finger
//   never opens it, and the system selection stays;
// - keyboard and screen readers: one button translates the selected word. It
//   is the first control inside the boundary, shown only while it has the
//   focus; focus moves into the card and returns to the button on close.
// The on/off switch is a single icon in the page header: the boundary
// renders it through a portal into the empty slot of the server header, so
// the state, the lookup and the card have one owner.

export const HEADER_SLOT_ID = 'training-header-slot';

const subscribeNothing = () => () => undefined;
const findHeaderSlot = () => document.getElementById(HEADER_SLOT_ID);
const noHeaderSlot = () => null;

// Hidden on screen, available to a screen reader and to the keyboard; it
// shows itself in the flow while it holds the focus.
const SKIP_ACTION_SX = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  minWidth: 0,
  minHeight: 0,
  m: '-1px',
  p: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  bgcolor: 'background.paper',
  '&:focus': {
    position: 'static',
    width: 'auto',
    height: 'auto',
    minHeight: 44,
    m: 0,
    mb: 1,
    px: 2,
    overflow: 'visible',
    clip: 'auto',
    whiteSpace: 'normal',
  },
} as const;

export const HOVER_DELAY_MS = 500;
// A finger must rest on one word this long before the sheet opens, and may
// drift this far (CSS pixels) while it does.
export const LONG_PRESS_MS = 1500;
const LONG_PRESS_TOLERANCE_PX = 10;
// How long after a release the click it may produce is still swallowed.
const CLICK_AFTER_RELEASE_MS = 400;
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
  const slot = useSyncExternalStore(
    subscribeNothing,
    findHeaderSlot,
    noHeaderSlot,
  );
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

  // The pointer listeners exist only while the translator is on. They are
  // native listeners of the boundary, so events inside the card (a portal)
  // never start a new lookup.
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    let hoverTimer = 0;
    let pressTimer = 0;
    let press: { x: number; y: number } | null = null;
    let isClickSuppressed = false;
    let suppressTimer = 0;
    let pointerType = 'mouse';

    const clearHover = () => window.clearTimeout(hoverTimer);

    const cancelPress = () => {
      window.clearTimeout(pressTimer);
      press = null;
    };

    // Touch and pen: a pending long press on the word under the finger.
    // Nothing is prevented here, so the native scroll stays untouched.
    const handlePointerDown = (event: PointerEvent) => {
      pointerType = event.pointerType;
      clearHover();
      cancelPress();
      isClickSuppressed = false;
      if (event.pointerType === 'mouse' || !event.isPrimary) return;
      if (!zoneOf(event.target as Node, root)) return;
      const start = { x: event.clientX, y: event.clientY };
      press = start;
      pressTimer = window.setTimeout(() => {
        if (press !== start) return;
        press = null;
        const hit = wordAtPoint(start.x, start.y, root);
        if (!hit) return;
        // The click that may follow the release must not act on the word.
        isClickSuppressed = true;
        openWord(hit, 'sheet', null);
      }, LONG_PRESS_MS);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') {
        if (!press) return;
        const moved = Math.hypot(
          event.clientX - press.x,
          event.clientY - press.y,
        );
        if (moved > LONG_PRESS_TOLERANCE_PX) cancelPress();
        return;
      }
      if (event.buttons !== 0) return;
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

    // The click of a release follows it at once; a flag left over from a
    // release without a click must not swallow a later keyboard click.
    const handlePointerRelease = () => {
      cancelPress();
      window.clearTimeout(suppressTimer);
      suppressTimer = window.setTimeout(() => {
        isClickSuppressed = false;
      }, CLICK_AFTER_RELEASE_MS);
    };

    // After a long press the release must neither open the word a second
    // time nor choose the answer of the label the word sits in.
    const handleClickCapture = (event: MouseEvent) => {
      if (!isClickSuppressed) return;
      isClickSuppressed = false;
      event.preventDefault();
      event.stopPropagation();
    };

    root.addEventListener('pointerdown', handlePointerDown);
    root.addEventListener('pointermove', handlePointerMove);
    root.addEventListener('pointerleave', clearHover);
    root.addEventListener('mouseup', handleMouseUp);
    root.addEventListener('click', handleClickCapture, true);
    document.addEventListener('pointerup', handlePointerRelease);
    document.addEventListener('pointercancel', handlePointerRelease);
    // A scroll of the page or of any inner box ends the wait.
    document.addEventListener('scroll', cancelPress, true);
    return () => {
      clearHover();
      cancelPress();
      window.clearTimeout(suppressTimer);
      root.removeEventListener('pointerdown', handlePointerDown);
      root.removeEventListener('pointermove', handlePointerMove);
      root.removeEventListener('pointerleave', clearHover);
      root.removeEventListener('mouseup', handleMouseUp);
      root.removeEventListener('click', handleClickCapture, true);
      document.removeEventListener('pointerup', handlePointerRelease);
      document.removeEventListener('pointercancel', handlePointerRelease);
      document.removeEventListener('scroll', cancelPress, true);
    };
  }, [enabled, openWord]);

  const isOpen = opened !== null;
  useEffect(() => {
    if (!isOpen) return;
    // The card is the topmost layer: it takes the Escape in the capture phase,
    // so a list of tasks open below it stays open.
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
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
      {slot
        ? createPortal(
            <DictionaryHeaderToggle
              isOn={enabled}
              onToggle={() => changeEnabled(!enabled)}
            />,
            slot,
          )
        : null}
      <Box ref={rootRef} data-testid="dictionary-boundary">
        {enabled ? (
          <>
            <Button
              ref={buttonRef}
              size="small"
              variant="outlined"
              data-testid="dictionary-translate-selection"
              onMouseDown={(event) => event.preventDefault()}
              onClick={translateSelection}
              sx={SKIP_ACTION_SX}
            >
              {t('translateSelection')}
            </Button>
            {notice ? (
              <Typography
                role="status"
                variant="body2"
                data-testid="dictionary-selection-notice"
                sx={{ mb: 1 }}
              >
                {t('selectOneWord')}
              </Typography>
            ) : null}
          </>
        ) : null}
        {children}
      </Box>
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
