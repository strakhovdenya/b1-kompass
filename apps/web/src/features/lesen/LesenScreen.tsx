'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ExamQuestion, ExamText, Selections } from '@b1k/domain';
import { QuestionCard } from '../practice/QuestionCard';
import { useTraining } from '../training/TrainingContext';

// The reading position: the paragraph of a text the guest has read up to.
export interface ReadingAnchor {
  textId: string;
  paragraph: number;
}

// One reading position per text, so going back to a text finds its place.
type Anchors = Readonly<Record<string, ReadingAnchor>>;

type View = 'text' | 'questions';

const PARAGRAPH_BREAK = /\n{2,}/;
const RESTORE_DELAY_FRAMES = 2;
const UNLOCK_DELAY_MS = 150;
const PARAGRAPH_SAVE_DELAY_MS = 600;
const PAGE_MARGIN_PX = 16;

export const splitParagraphs = (body: string): string[] =>
  body.split(PARAGRAPH_BREAK).filter((paragraph) => paragraph.trim() !== '');

export const selectLesenQuestions = (
  questions: readonly ExamQuestion[],
): ExamQuestion[] =>
  questions
    .filter((question) => question.skill === 'lesen')
    .sort((a, b) => a.number - b.number);

// A stored anchor that does not point to a paragraph of this text opens the
// text from its first paragraph.
export const resolveAnchor = (
  anchor: ReadingAnchor | null | undefined,
  textId: string,
  paragraphCount: number,
): number => {
  if (!anchor || anchor.textId !== textId) return 0;
  const { paragraph } = anchor;
  const isValid =
    Number.isInteger(paragraph) && paragraph >= 0 && paragraph < paragraphCount;
  return isValid ? paragraph : 0;
};

const isPanelScrollable = (panel: HTMLElement): boolean =>
  getComputedStyle(panel).overflowY === 'auto';

const isShown = (element: HTMLElement): boolean =>
  element.getClientRects().length > 0;

const paragraphsOf = (panel: HTMLElement): HTMLElement[] =>
  Array.from(panel.querySelectorAll<HTMLElement>('[data-paragraph]'));

// The first paragraph that still reaches into the visible part of the text.
const readFirstVisible = (panel: HTMLElement): number | null => {
  const top = isPanelScrollable(panel) ? panel.getBoundingClientRect().top : 0;
  const paragraphs = paragraphsOf(panel);
  const index = paragraphs.findIndex(
    (paragraph) => paragraph.getBoundingClientRect().bottom > top + 1,
  );
  return index === -1 ? null : index;
};

const trackPosition = (
  panel: HTMLElement,
  textId: string,
): ReadingAnchor | null => {
  if (!isShown(panel)) return null;
  const paragraph = readFirstVisible(panel);
  return paragraph === null ? null : { textId, paragraph };
};

const scrollToParagraph = (panel: HTMLElement, index: number) => {
  const target = paragraphsOf(panel)[index];
  if (!target) return;
  const targetTop = target.getBoundingClientRect().top;
  if (isPanelScrollable(panel)) {
    panel.scrollTop += targetTop - panel.getBoundingClientRect().top;
    // The page itself may still be scrolled from the narrow layout.
    const { top, height } = target.getBoundingClientRect();
    const isInView = top >= 0 && top + height <= window.innerHeight;
    if (!isInView) window.scrollBy(0, top - PAGE_MARGIN_PX);
  } else {
    window.scrollBy(0, targetTop);
  }
};

const restorePosition = (
  panel: HTMLElement | null,
  textId: string | undefined,
  stored: Anchors,
) => {
  const anchor = textId ? stored[textId] : undefined;
  if (!panel || !textId || !anchor || !isShown(panel)) return;
  const count = paragraphsOf(panel).length;
  scrollToParagraph(panel, resolveAnchor(anchor, textId, count));
};

interface LesenScreenProps {
  questions: readonly ExamQuestion[];
  texts: readonly ExamText[];
  initialSelections: Selections;
  initialAnchor?: ReadingAnchor | null;
}

// Lesen Teil 1–5: one task at a time beside its own text. On a wide screen the
// text and the task are visible together; on a narrow one the guest switches
// between them. Both panels stay in the page, only CSS hides one, so a choice,
// a failed save and the reading position survive a change of layout. Answers
// are chosen, saved and retried through the training shell, which keeps the
// unconfirmed ones across navigation and blocks.
export const LesenScreen = ({
  questions,
  texts,
  initialSelections,
  initialAnchor = null,
}: LesenScreenProps) => {
  const t = useTranslations('lesen');
  const tSet = useTranslations('set');
  const tPractice = useTranslations('practice');
  const lesen = selectLesenQuestions(questions);
  const training = useTraining();
  const { pending, choose, retry, readProgress, reportProgress } = training;
  const [stored] = useState(() => readProgress()?.lesen ?? null);
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      lesen.findIndex((item) => item.id === stored?.itemId),
    ),
  );
  const [view, setView] = useState<View>('text');
  // The shell knows every answer confirmed since the page was loaded; the
  // page's own answers count outside a shell (component tests).
  const selections = { ...initialSelections, ...training.selections };
  const storedAnchor =
    stored?.textId !== undefined && stored.paragraph !== undefined
      ? { textId: stored.textId, paragraph: stored.paragraph }
      : initialAnchor;
  const [anchors, setAnchors] = useState<Anchors>(
    storedAnchor ? { [storedAnchor.textId]: storedAnchor } : {},
  );
  const anchorsRef = useRef(anchors);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const isLocked = useRef(false);

  const question = lesen[index];
  const text = texts.find((item) => item.id === question?.textId) ?? null;
  const textId = text?.id;

  // The task is saved when it changes; the paragraph a moment after the
  // guest stops scrolling, so a scroll is not one request per paragraph.
  const questionId = question?.id;
  const paragraph = textId ? anchors[textId]?.paragraph : undefined;
  useEffect(() => {
    if (!questionId) return;
    reportProgress({
      block: 'lesen',
      lesen: {
        itemId: questionId,
        textId,
        paragraph: textId ? anchorsRef.current[textId]?.paragraph : undefined,
      },
    });
  }, [questionId, textId, reportProgress]);
  useEffect(() => {
    if (paragraph === undefined) return;
    const timer = window.setTimeout(
      () => reportProgress({ block: 'lesen', lesen: { textId, paragraph } }),
      PARAGRAPH_SAVE_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [textId, paragraph, reportProgress]);

  // Layout changes (resize comes before the scroll events it causes): the
  // position is put back after the new layout is painted.
  useEffect(() => {
    let frame = 0;
    let timer = 0;
    const handleScroll = () => {
      const panel = panelRef.current;
      if (isLocked.current || !textId || !panel) return;
      const next = trackPosition(panel, textId);
      if (!next) return;
      if (anchorsRef.current[textId]?.paragraph === next.paragraph) return;
      anchorsRef.current = { ...anchorsRef.current, [textId]: next };
      setAnchors(anchorsRef.current);
    };
    const settle = (frames: number) => {
      if (frames > 0) {
        frame = requestAnimationFrame(() => settle(frames - 1));
        return;
      }
      restorePosition(panelRef.current, textId, anchorsRef.current);
      timer = window.setTimeout(() => {
        isLocked.current = false;
        handleScroll();
      }, UNLOCK_DELAY_MS);
    };
    const handleResize = () => {
      isLocked.current = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      settle(RESTORE_DELAY_FRAMES);
    };
    const panel = panelRef.current;
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll, { passive: true });
    panel?.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll);
      panel?.removeEventListener('scroll', handleScroll);
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [textId]);

  // Switching the narrow panels brings the text back to the same paragraph.
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      restorePosition(panelRef.current, textId, anchorsRef.current),
    );
    return () => cancelAnimationFrame(frame);
  }, [view, textId]);

  if (!question) {
    return <Alert severity="warning">{tPractice('unavailable')}</Alert>;
  }

  const total = lesen.length;
  // Navigation waits only for the saves of the Lesen tasks.
  const isSaving = lesen.some((item) => pending[item.id]?.status === 'saving');
  const answered = lesen.filter((item) =>
    Object.hasOwn(selections, item.id),
  ).length;

  const choice = Object.hasOwn(pending, question.id)
    ? pending[question.id]
    : undefined;
  const paragraphs = text ? splitParagraphs(text.body) : [];
  const shownAnchor = text
    ? resolveAnchor(anchors[text.id], text.id, paragraphs.length)
    : 0;

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {t('intro', { count: total })}
      </Typography>
      <nav aria-label={tSet('navigation')}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap' }}
        >
          <Typography data-testid="set-position" sx={{ mr: 1 }}>
            {tSet('position', { current: index + 1, total })}
          </Typography>
          {lesen.map((item, itemIndex) => (
            <Button
              key={item.id}
              size="small"
              variant={itemIndex === index ? 'contained' : 'outlined'}
              aria-current={itemIndex === index ? 'step' : undefined}
              aria-label={tSet('goTo', { number: item.number, count: 1 })}
              data-testid={`go-to-question-${item.number}`}
              disabled={isSaving}
              onClick={() => setIndex(itemIndex)}
              sx={{ minWidth: 40 }}
            >
              {item.number}
            </Button>
          ))}
        </Stack>
      </nav>
      {text ? (
        <>
          <Stack
            direction="row"
            spacing={1}
            sx={{ display: { xs: 'flex', md: 'none' } }}
          >
            {(['text', 'questions'] as const).map((item) => (
              <Button
                key={item}
                variant={view === item ? 'contained' : 'outlined'}
                aria-pressed={view === item}
                data-testid={`lesen-view-${item}`}
                onClick={() => setView(item)}
              >
                {t(item === 'text' ? 'showText' : 'showQuestions')}
              </Button>
            ))}
          </Stack>
          <Box
            sx={{
              display: { xs: 'block', md: 'grid' },
              gridTemplateColumns: { md: '1fr 1fr' },
              gap: 2,
              alignItems: 'start',
            }}
          >
            <Paper
              key={text.id}
              ref={panelRef}
              component="section"
              variant="outlined"
              aria-label={t('textRegion')}
              data-testid="reading-text"
              data-text-id={text.id}
              data-anchor={shownAnchor}
              sx={{
                p: { xs: 2, sm: 3 },
                display: {
                  xs: view === 'text' ? 'block' : 'none',
                  md: 'block',
                },
                overflowY: { xs: 'visible', md: 'auto' },
                position: { md: 'sticky' },
                top: { md: 16 },
                maxHeight: { md: 'calc(100vh - 32px)' },
              }}
            >
              <Typography component="h2" variant="h6" lang="de" gutterBottom>
                {text.title}
              </Typography>
              <Stack spacing={2} lang="de">
                {paragraphs.map((paragraph, paragraphIndex) => (
                  <Typography
                    key={paragraphIndex}
                    data-paragraph={paragraphIndex}
                    data-testid={`reading-paragraph-${paragraphIndex}`}
                    sx={{ whiteSpace: 'pre-wrap' }}
                  >
                    {paragraph}
                  </Typography>
                ))}
              </Stack>
            </Paper>
            <Box
              sx={{
                display: {
                  xs: view === 'questions' ? 'block' : 'none',
                  md: 'block',
                },
              }}
            >
              <QuestionCard
                key={question.id}
                question={question}
                selectedOptionId={
                  choice?.optionId ?? selections[question.id] ?? null
                }
                status={choice?.status}
                onChoose={(optionId) => choose(question.id, optionId)}
                onRetry={() => retry(question.id)}
              />
            </Box>
          </Box>
        </>
      ) : (
        <Alert severity="error" role="alert" data-testid="reading-missing">
          {t('missingText')}
        </Alert>
      )}
      <Stack direction="row" spacing={1}>
        <Button
          variant="outlined"
          data-testid="set-previous"
          disabled={index === 0 || isSaving}
          onClick={() => setIndex(index - 1)}
        >
          {tSet('previous')}
        </Button>
        <Button
          variant="outlined"
          data-testid="set-next"
          disabled={index === total - 1 || isSaving}
          onClick={() => setIndex(index + 1)}
        >
          {tSet('next')}
        </Button>
      </Stack>
      <Typography data-testid="set-answered">
        {tSet('answered', { answered, total })}
      </Typography>
    </Stack>
  );
};
