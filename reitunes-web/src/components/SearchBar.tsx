import { useState, useEffect, useRef, useCallback } from 'react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onRandomBookmark?: () => void;
}

const DiceIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="8.5" cy="15.5" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="15.5" r="1.5" fill="currentColor" stroke="none" />
  </svg>
);

const SearchIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

export function SearchBar({ value, onChange, onRandomBookmark }: SearchBarProps) {
  const [localValue, setLocalValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      if (localValue !== value) {
        onChange(localValue);
      }
    }, 150);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [localValue, value, onChange]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.ctrlKey && e.key === 'e') {
        e.preventDefault();
        onRandomBookmark?.();
      }
      if (e.key === 'Escape' && document.activeElement === inputRef.current) {
        inputRef.current?.blur();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onRandomBookmark]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLocalValue(e.target.value);
  }, []);

  return (
    <div className="flex items-center gap-1">
      <div className="relative">
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-solarized-base01">
          {SearchIcon}
        </span>
        <input
          ref={inputRef}
          type="text"
          value={localValue}
          onChange={handleChange}
          placeholder="Search..."
          className="w-72 pl-8 pr-2 py-1 bg-solarized-base02 text-solarized-base1 text-sm rounded border border-transparent focus:border-solarized-blue focus:outline-none placeholder-solarized-base01"
          autoComplete="off"
        />
      </div>
      {onRandomBookmark && (
        <button
          onClick={onRandomBookmark}
          className="p-1.5 text-solarized-base01 hover:text-solarized-cyan rounded transition-colors"
          title="Random bookmark (Ctrl+E)"
        >
          {DiceIcon}
        </button>
      )}
    </div>
  );
}
