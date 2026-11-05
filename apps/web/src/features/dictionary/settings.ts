import { useCallback, useSyncExternalStore } from 'react';

// Whether the dictionary is on: one boolean of this browser in localStorage,
// on by default in the free training. Server rendering and the first
// hydration use the default; the stored value follows right after.

export const DICTIONARY_SETTING_KEY = 'b1k.dictionary.enabled.v1';
const CHANGE_EVENT = 'b1k-dictionary-setting';

export const parseEnabled = (stored: string | null): boolean =>
  stored !== 'false';

const readEnabled = (): boolean => {
  try {
    return parseEnabled(window.localStorage.getItem(DICTIONARY_SETTING_KEY));
  } catch {
    return true;
  }
};

const subscribe = (onChange: () => void) => {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === DICTIONARY_SETTING_KEY) onChange();
  };
  window.addEventListener('storage', handleStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
};

const writeEnabled = (enabled: boolean) => {
  try {
    window.localStorage.setItem(DICTIONARY_SETTING_KEY, String(enabled));
  } catch {
    // Storage may be blocked; the switch still works for this page.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

const serverEnabled = () => true;

export const useDictionarySetting = (): [boolean, (next: boolean) => void] => {
  const enabled = useSyncExternalStore(subscribe, readEnabled, serverEnabled);
  const setEnabled = useCallback((next: boolean) => writeEnabled(next), []);
  return [enabled, setEnabled];
};
