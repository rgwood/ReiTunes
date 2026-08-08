import { useState, useCallback, useRef, useEffect } from 'react';

type DownloadType = 'Audio' | 'Video';

interface DownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// Very loose check, just used to decide whether to pre-fill from the clipboard.
function looksLikeUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

export function DownloadModal({ isOpen, onClose }: DownloadModalProps) {
  const [url, setUrl] = useState('');
  const [dlType, setDlType] = useState<DownloadType>('Audio');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const resetState = useCallback(() => {
    setUrl('');
    setDlType('Audio');
    setStatus('idle');
    setMessage(null);
  }, []);

  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [resetState, onClose]);

  // Autofocus and try to pre-fill from clipboard whenever the modal opens.
  useEffect(() => {
    if (!isOpen) return;

    inputRef.current?.focus();

    (async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (looksLikeUrl(text)) {
          setUrl(text.trim());
        }
      } catch {
        // Clipboard read can fail without permission - that's fine, leave the field empty.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleSubmit = useCallback(async () => {
    if (!url.trim() || status === 'submitting') return;

    setStatus('submitting');
    setMessage(null);

    try {
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), dl_type: dlType }),
      });

      const raw = await response.text();
      // The downloader returns a JSON-encoded string; unwrap it for display
      let text = raw;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') text = parsed;
      } catch {
        // not JSON, use as-is
      }

      if (!response.ok) {
        setStatus('error');
        setMessage(text || 'Download request failed');
        return;
      }

      setStatus('success');
      setMessage(text || 'Download queued successfully');
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Download request failed');
    }
  }, [url, dlType, status]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  if (!isOpen) return null;

  const isSubmitting = status === 'submitting';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-solarized-base02 border border-solarized-blue rounded-lg p-6 w-[500px] max-w-full flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg text-solarized-base1">Download from URL</h2>
          <button
            onClick={handleClose}
            className="text-solarized-base0 hover:text-solarized-base1"
          >
            &#10005;
          </button>
        </div>

        {/* URL input */}
        <input
          ref={inputRef}
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="https://..."
          disabled={isSubmitting}
          className="w-full px-3 py-2 rounded bg-solarized-base03 border border-solarized-base01 text-solarized-base1 placeholder-solarized-base00 focus:outline-none focus:border-solarized-blue"
        />

        {/* Audio/Video toggle */}
        <div className="mt-4 flex gap-2">
          {(['Audio', 'Video'] as const).map((option) => (
            <button
              key={option}
              onClick={() => setDlType(option)}
              disabled={isSubmitting}
              className={`px-4 py-1.5 rounded transition-colors ${
                dlType === option
                  ? 'bg-solarized-blue text-solarized-base03'
                  : 'bg-solarized-base01 text-solarized-base1 hover:bg-solarized-base00'
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        {/* Status feedback */}
        {message && (
          <div
            className={`mt-4 text-sm ${
              status === 'error' ? 'text-solarized-red' : 'text-solarized-green'
            }`}
          >
            {message}
          </div>
        )}

        {/* Actions */}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={handleClose}
            disabled={isSubmitting}
            className={`px-4 py-2 rounded transition-colors ${
              isSubmitting
                ? 'bg-solarized-base01 text-solarized-base00 cursor-not-allowed'
                : 'bg-solarized-base01 text-solarized-base03 hover:bg-solarized-base00'
            }`}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting || !url.trim()}
            className={`px-4 py-2 rounded transition-colors ${
              isSubmitting || !url.trim()
                ? 'bg-solarized-base01 text-solarized-base00 cursor-not-allowed'
                : 'bg-solarized-blue text-solarized-base03 hover:bg-solarized-cyan'
            }`}
          >
            {isSubmitting ? 'Queuing...' : 'Download'}
          </button>
        </div>
      </div>
    </div>
  );
}
