import { useEffect, useId, useRef, useSyncExternalStore } from 'react';
import {
  THEMES,
  getSnapshot,
  setThemePreference,
  subscribe,
  type ThemeId,
  type ThemeMode,
} from '../themes';
import { MusicIcon } from './MusicIcon';
import './SettingsDialog.css';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  outputName: string;
  onChooseOutput: () => void;
}

export function SettingsDialog({
  isOpen,
  onClose,
  outputName,
  onChooseOutput,
}: SettingsDialogProps) {
  const preference = useSyncExternalStore(subscribe, getSnapshot);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const modeRef = useRef<HTMLSelectElement>(null);
  const id = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      dialog.showModal();
      modeRef.current?.focus();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="settings-content">
        <header className="settings-header">
          <h2 id={`${id}-title`}>Settings</h2>
          <button
            className="settings-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            <MusicIcon name="close" size={14} />
          </button>
        </header>
        <section aria-labelledby={`${id}-appearance`}>
          <h3 id={`${id}-appearance`}>Appearance</h3>
          <label className="settings-field" htmlFor={`${id}-mode`}>
            <span>Mode</span>
            <select
              ref={modeRef}
              id={`${id}-mode`}
              value={preference.mode}
              onChange={(event) =>
                setThemePreference({
                  ...preference,
                  mode: event.target.value as ThemeMode,
                })
              }
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          {(['light', 'dark'] as const).map((mode) => (
            <label
              className="settings-field"
              htmlFor={`${id}-${mode}`}
              key={mode}
            >
              <span>{mode === 'light' ? 'Light theme' : 'Dark theme'}</span>
              <select
                id={`${id}-${mode}`}
                value={preference[`${mode}Theme`]}
                onChange={(event) =>
                  setThemePreference({
                    ...preference,
                    [`${mode}Theme`]: event.target.value as ThemeId,
                  })
                }
              >
                {THEMES.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </section>
        <section aria-labelledby={`${id}-playback`}>
          <h3 id={`${id}-playback`}>Playback</h3>
          <div className="settings-output">
            <span>Output</span>
            <span title={outputName}>{outputName}</span>
            <button
              onClick={() => {
                dialogRef.current?.close();
                onChooseOutput();
              }}
            >
              Choose output
            </button>
          </div>
        </section>
        <footer>
          <button onClick={onClose}>Done</button>
        </footer>
      </div>
    </dialog>
  );
}
