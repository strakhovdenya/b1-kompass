'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { Locale } from '@b1k/domain';
import type { DictionaryEntry } from './entry';
import { MYMEMORY_HOME, OPENTHESAURUS_HOME, dictionaryLinks } from './links';
import type { LookupFailure, LookupState } from './lookup';
import { speakGerman } from './speech';
import type { SpeechResult } from './speech';

// The content of the dictionary card: the word, its pronunciation, what the
// sources confirmed, and links to other dictionaries. Every provider string
// is plain React text; the only links are the ones built in links.ts.

type OpenState = Exclude<LookupState, { status: 'closed' }>;

interface DictionaryCardProps {
  state: OpenState;
  target: Locale;
  titleId: string;
  // Opened from the keyboard: the title takes the focus when it appears.
  shouldFocusTitle?: boolean;
  onClose: () => void;
  onLookup: (word: string) => void;
  speak?: (word: string) => SpeechResult;
}

const FAILURE_KEYS: Readonly<Record<LookupFailure, string>> = {
  'invalid-input': 'invalidWord',
  'invalid-word': 'invalidWord',
  'session-invalid': 'sessionInvalid',
  unavailable: 'unavailable',
  network: 'unavailable',
};

const EXTERNAL = { target: '_blank', rel: 'noopener noreferrer' } as const;

const WORD_SX = { overflowWrap: 'anywhere', minWidth: 0 } as const;

interface EntryViewProps {
  entry: DictionaryEntry;
  onLookup: (word: string) => void;
}

const TranslationView = ({ entry }: { entry: DictionaryEntry }) => {
  const t = useTranslations('dictionary');
  const { translation, target } = entry;
  if (translation.state !== 'found' || translation.text === null) {
    const key =
      translation.state === 'not-found'
        ? 'notFound'
        : translation.state === 'limited'
          ? 'limited'
          : 'translationUnavailable';
    return (
      <Typography
        role="status"
        color="text.secondary"
        data-testid="dictionary-translation-state"
        data-state={translation.state}
      >
        {t(key)}
      </Typography>
    );
  }
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" component="p">
        {t('translation')}
      </Typography>
      <Typography
        lang={target}
        data-testid="dictionary-translation"
        sx={{ fontWeight: 600, ...WORD_SX }}
      >
        {translation.text}
      </Typography>
      {translation.alternatives.length > 0 ? (
        <Typography
          variant="body2"
          lang={target}
          data-testid="dictionary-alternatives"
          sx={WORD_SX}
        >
          {t('alternatives')} {translation.alternatives.join('; ')}
        </Typography>
      ) : null}
    </Box>
  );
};

const LexicalView = ({ entry, onLookup }: EntryViewProps) => {
  const t = useTranslations('dictionary');
  const { lexical } = entry;
  if (lexical.state === 'unavailable' || lexical.state === 'limited') {
    return (
      <Typography
        variant="body2"
        color="text.secondary"
        data-testid="dictionary-lexical-state"
        data-state={lexical.state}
      >
        {t('lexicalUnavailable')}
      </Typography>
    );
  }
  if (lexical.state !== 'found') return null;
  return (
    <Stack spacing={1}>
      {lexical.baseform ? (
        <Typography variant="body2" data-testid="dictionary-baseform">
          {t('baseform')}{' '}
          <Box component="span" lang="de" sx={{ fontWeight: 600 }}>
            {lexical.baseform}
          </Box>
        </Typography>
      ) : null}
      {lexical.synonyms.length > 0 ? (
        <Box>
          <Typography variant="caption" color="text.secondary" component="p">
            {t('synonyms')}
          </Typography>
          <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1 }}>
            {lexical.synonyms.map((synonym) => (
              <Button
                key={synonym}
                size="small"
                variant="outlined"
                lang="de"
                data-testid="dictionary-synonym"
                aria-label={t('lookUp', { word: synonym })}
                onClick={() => onLookup(synonym)}
                sx={{ minHeight: 36, textTransform: 'none', ...WORD_SX }}
              >
                {synonym}
              </Button>
            ))}
          </Stack>
        </Box>
      ) : null}
    </Stack>
  );
};

const SourcesView = () => {
  const t = useTranslations('dictionary');
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      component="p"
      data-testid="dictionary-attribution"
    >
      {t('sourceTranslation')}{' '}
      <Link href={MYMEMORY_HOME} {...EXTERNAL}>
        MyMemory
      </Link>
      {' · '}
      {t('sourceSynonyms')}{' '}
      <Link
        href={OPENTHESAURUS_HOME}
        {...EXTERNAL}
        data-testid="dictionary-openthesaurus"
      >
        OpenThesaurus
      </Link>
    </Typography>
  );
};

const SPEECH_KEYS: Readonly<Record<SpeechResult, string | null>> = {
  started: null,
  unavailable: 'speechUnavailable',
  'no-german-voice': 'speechNoVoice',
};

export const DictionaryCard = ({
  state,
  target,
  titleId,
  shouldFocusTitle = false,
  onClose,
  onLookup,
  speak = speakGerman,
}: DictionaryCardProps) => {
  const t = useTranslations('dictionary');
  const [speech, setSpeech] = useState<{
    word: string;
    result: SpeechResult;
  } | null>(null);
  const { word } = state;
  const titleRef = useCallback(
    (node: HTMLHeadingElement | null) => {
      if (node && shouldFocusTitle) node.focus({ preventScroll: true });
    },
    [shouldFocusTitle],
  );
  const speechKey =
    speech && speech.word === word ? SPEECH_KEYS[speech.result] : null;

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <Typography
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
          component="h2"
          variant="h6"
          lang="de"
          data-testid="dictionary-word"
          sx={{ flexGrow: 1, ...WORD_SX }}
        >
          {word}
        </Typography>
        <IconButton
          aria-label={t('close')}
          data-testid="dictionary-close"
          onClick={onClose}
          sx={{ width: 44, height: 44 }}
        >
          <Box component="span" aria-hidden="true" sx={{ fontSize: 24 }}>
            ×
          </Box>
        </IconButton>
      </Stack>
      <Box>
        <Button
          size="small"
          variant="text"
          data-testid="dictionary-speak"
          aria-label={t('speakWord', { word })}
          onClick={() => setSpeech({ word, result: speak(word) })}
          sx={{ minHeight: 36 }}
        >
          {t('speak')}
        </Button>
        {speechKey ? (
          <Typography
            role="status"
            variant="body2"
            color="text.secondary"
            data-testid="dictionary-speech-fallback"
          >
            {t(speechKey)}
          </Typography>
        ) : null}
      </Box>
      {state.status === 'loading' ? (
        <Stack
          direction="row"
          spacing={1}
          role="status"
          data-testid="dictionary-loading"
          sx={{ alignItems: 'center' }}
        >
          <CircularProgress size={16} aria-hidden="true" />
          <Typography variant="body2">{t('loading')}</Typography>
        </Stack>
      ) : null}
      {state.status === 'error' ? (
        <Alert severity="warning" role="alert" data-testid="dictionary-error">
          {t(FAILURE_KEYS[state.failure])}
        </Alert>
      ) : null}
      {state.status === 'ready' ? (
        <Stack spacing={1.5} data-testid="dictionary-result">
          <TranslationView entry={state.entry} />
          <LexicalView entry={state.entry} onLookup={onLookup} />
        </Stack>
      ) : null}
      <Box>
        <Typography variant="caption" color="text.secondary" component="p">
          {t('moreDictionaries')}
        </Typography>
        <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 2 }}>
          {dictionaryLinks(word, target).map((link) => (
            <Link
              key={link.id}
              href={link.href}
              {...EXTERNAL}
              data-testid={`dictionary-link-${link.id}`}
              sx={{ py: 0.5 }}
            >
              {t(`links.${link.id}`)}
            </Link>
          ))}
        </Stack>
      </Box>
      <SourcesView />
    </Stack>
  );
};
