'use client';

import { createContext, useContext } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { ZONE_ATTRIBUTE } from './dom';

// Whether a dictionary boundary with the translator switched on surrounds the
// text. Outside a boundary (and with the translator off) German text keeps
// its original markup and behaviour.
export const DictionaryActiveContext = createContext(false);

// Inside an answer label a click on the words opens the card instead of
// choosing the answer: the label's activation is cancelled, the radio itself
// still works by its own control and by keyboard.
const keepAnswer = (event: MouseEvent<HTMLSpanElement>) => {
  if (event.currentTarget.closest('label')) event.preventDefault();
};

interface GermanTextProps {
  children: ReactNode;
}

// A German text zone of the material: the text is rendered unchanged, words
// are not separate elements and never become tab stops.
export const GermanText = ({ children }: GermanTextProps) => {
  const isActive = useContext(DictionaryActiveContext);
  if (!isActive) return <>{children}</>;
  const zone = { [ZONE_ATTRIBUTE]: '' };
  return (
    <span {...zone} onClick={keepAnswer}>
      {children}
    </span>
  );
};
