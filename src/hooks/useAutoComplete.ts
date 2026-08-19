import { useState, useEffect, useRef, useCallback } from 'react';
import { getSuggestions } from '../utils/masterData';

export interface Suggestion { value: string; code?: number; }

export function useAutoComplete(field: string, value: string) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (value.length < 1) { setSuggestions([]); setOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      const results = await getSuggestions(field, value);
      // exact match = user just selected it or finished typing a known name — keep closed
      const exact = results.length === 1 && results[0].value.trim().toLowerCase() === value.trim().toLowerCase();
      setSuggestions(results);
      setOpen(results.length > 0 && !exact);
      setActiveIndex(-1);
    }, 120);
    return () => clearTimeout(debounceRef.current);
  }, [field, value]);

  const close = useCallback(() => { setOpen(false); setActiveIndex(-1); }, []);

  const handleKeyDown = useCallback((
    e: React.KeyboardEvent,
    onSelect: (v: string) => void
  ) => {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      onSelect(suggestions[activeIndex].value);
      close();
    } else if (e.key === 'Escape') {
      close();
    }
  }, [open, suggestions, activeIndex, close]);

  return { suggestions, open, activeIndex, close, handleKeyDown };
}
