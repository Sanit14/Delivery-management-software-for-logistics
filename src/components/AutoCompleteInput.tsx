import React, { useRef, useEffect } from 'react';
import { useAutoComplete } from '../hooks/useAutoComplete';

interface AutoCompleteInputProps {
  field: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  required?: boolean;
  onEnter?: () => void;
  hint?: string;
  hasError?: boolean;
  tabIndex?: number;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  style?: React.CSSProperties;
}

export default function AutoCompleteInput({
  field, value, onChange, placeholder, className = '', required, onEnter, hint, hasError, tabIndex, inputRef: externalRef, style,
}: AutoCompleteInputProps) {
  const { suggestions, open, activeIndex, close, handleKeyDown } = useAutoComplete(field, value);
  const wrapRef = useRef<HTMLDivElement>(null);
  const internalRef = useRef<HTMLInputElement>(null);
  const ref = externalRef || internalRef;

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [close]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    handleKeyDown(e, (v) => onChange(v));
    if (e.key === 'Enter' && activeIndex < 0 && onEnter) {
      e.preventDefault();
      onEnter();
    }
  };

  return (
    <div className="ac-wrap" ref={wrapRef}>
      <input
        ref={ref as React.RefObject<HTMLInputElement>}
        type="text"
        className={`form-input ${hasError ? 'field-error' : ''} ${className}`}
        style={style}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        required={required}
        tabIndex={tabIndex}
        autoComplete="off"
      />
      {hint && <div className="form-hint">e.g. {hint}</div>}
      {open && (
        <div className="ac-dropdown">
          {suggestions.map((s, i) => (
            <div
              key={`${s.value}-${i}`}
              className={`ac-item ${i === activeIndex ? 'ac-active' : ''}`}
              onMouseDown={() => { onChange(s.value); close(); }}
            >
              <span>{s.value}</span>
              {s.code != null && <span className="ac-code">{String(s.code).padStart(4, '0')}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
