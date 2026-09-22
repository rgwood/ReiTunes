import { useRef, type ComponentProps } from 'react';
import { completeMetadata } from '../utils/metadataSuggestions';

type MetadataInputProps = Omit<ComponentProps<'input'>, 'value' | 'onChange'> & {
  value: string;
  onValueChange: (value: string) => void;
  suggestions?: readonly string[];
};

export function MetadataInput({ value, onValueChange, suggestions = [], onCompositionStart, onCompositionEnd, ...props }: MetadataInputProps) {
  const composing = useRef(false);
  return <input {...props} value={value} autoComplete="off" aria-autocomplete={suggestions.length ? 'inline' : undefined}
    onCompositionStart={event => { composing.current = true; onCompositionStart?.(event); }}
    onCompositionEnd={event => { composing.current = false; onCompositionEnd?.(event); }}
    onChange={event => {
      const input = event.currentTarget;
      const typed = input.value;
      const native = event.nativeEvent as InputEvent;
      // Only complete ordinary typing. Pasted, dropped, and composed text is
      // already the user's chosen value and must stay unchanged.
      const canComplete = !composing.current && !native.isComposing && native.inputType === 'insertText' &&
        input.selectionStart === typed.length && input.selectionEnd === typed.length;
      const completed = canComplete ? completeMetadata(typed, suggestions) : typed;
      onValueChange(completed);
      if (completed.length > typed.length) {
        // The next typed character replaces the suggested suffix. Set the
        // selection even when React's value hasn't changed between keystrokes.
        input.value = completed;
        input.setSelectionRange(typed.length, completed.length);
      }
    }} />;
}
