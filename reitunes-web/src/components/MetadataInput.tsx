import type { ComponentProps } from 'react';
import { completeMetadata } from '../utils/metadataSuggestions';

type MetadataInputProps = Omit<ComponentProps<'input'>, 'value' | 'onChange'> & {
  value: string;
  onValueChange: (value: string) => void;
  suggestions?: readonly string[];
};

export function MetadataInput({ value, onValueChange, suggestions = [], ...props }: MetadataInputProps) {
  return <input {...props} value={value} autoComplete="off" aria-autocomplete={suggestions.length ? 'inline' : undefined}
    onChange={event => {
      const input = event.currentTarget;
      const typed = input.value;
      const native = event.nativeEvent as InputEvent;
      const canComplete = !native.isComposing && native.inputType?.startsWith('insert') &&
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
