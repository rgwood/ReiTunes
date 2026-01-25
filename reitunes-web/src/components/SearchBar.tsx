import { useState, useEffect, useRef, useCallback } from 'react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onRandomBookmark?: () => void;
}

export function SearchBar({ value, onChange, onRandomBookmark }: SearchBarProps) {
  const [localValue, setLocalValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  // Sync local value when prop changes
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  // Debounced search
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

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+F to focus search
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      // Ctrl+E for random bookmark
      if (e.ctrlKey && e.key === 'e') {
        e.preventDefault();
        onRandomBookmark?.();
      }
      // Escape to blur search
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
    <div className="flex items-center space-x-2">
      <div className="relative w-48">
        <input
          ref={inputRef}
          type="text"
          value={localValue}
          onChange={handleChange}
          placeholder="Search..."
          className="w-full px-2 py-1 bg-solarized-base03 text-solarized-base1 border border-solarized-blue text-lg placeholder-solarized-base00"
          autoComplete="off"
        />
      </div>
      {onRandomBookmark && (
        <button
          onClick={onRandomBookmark}
          className="px-3 py-1 bg-solarized-blue text-solarized-base03 rounded hover:bg-solarized-cyan transition-colors duration-300"
          title="Play random bookmark (Ctrl+E)"
        >
          &#127922;
        </button>
      )}
    </div>
  );
}
