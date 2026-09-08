import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import './ImportMusic.css';

interface ImportMusicProps {
  isOpen: boolean;
  onClose: () => void;
  onImported: () => void;
  droppedFiles?: File[];
  onDroppedFilesConsumed?: () => void;
}

interface UploadResult {
  id: string;
  name: string;
  artist: string | null;
  album: string | null;
  file_path: string;
}

interface StagedFile {
  id: number;
  file: File;
  status: 'ready' | 'importing' | 'imported' | 'error';
  result?: UploadResult;
  error?: string;
}

type Source = 'files' | 'url';
type DownloadType = 'Audio' | 'Video';

const AUDIO_EXTENSIONS =
  /\.(mp3|m4a|flac|wav|wave|ogg|oga|opus|aac|aif|aiff|alac|wma|mp4a|m4b|weba)$/i;

function isAudioFile(file: File) {
  return file.type.startsWith('audio/') || AUDIO_EXTENSIONS.test(file.name);
}

function fileIdentity(file: File) {
  return `${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`;
}

function fileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ImportIcon({
  kind,
  ...props
}: {
  kind: 'check' | 'close';
} & React.SVGProps<SVGSVGElement>) {
  const paths: Record<typeof kind, ReactNode> = {
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[kind]}
    </svg>
  );
}

async function responseMessage(response: Response) {
  const raw = await response.text();
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : raw;
  } catch {
    return raw;
  }
}

export function ImportMusic({
  isOpen,
  onClose,
  onImported,
  droppedFiles,
  onDroppedFilesConsumed,
}: ImportMusicProps) {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileTabRef = useRef<HTMLButtonElement>(null);
  const urlTabRef = useRef<HTMLButtonElement>(null);
  const nextId = useRef(0);
  const lastDroppedFiles = useRef<File[] | undefined>(undefined);
  const busyRef = useRef(false);
  const titleId = useId();
  const tabsId = useId();
  const urlId = useId();
  const [source, setSource] = useState<Source>('files');
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [selectionMessage, setSelectionMessage] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [batchProgress, setBatchProgress] = useState({
    completed: 0,
    total: 0,
  });
  const [url, setUrl] = useState('');
  const [downloadType, setDownloadType] = useState<DownloadType>('Audio');
  const [downloadStatus, setDownloadStatus] = useState<
    'idle' | 'submitting' | 'queued' | 'error'
  >('idle');
  const [downloadMessage, setDownloadMessage] = useState('');
  const isBusy = isImporting || downloadStatus === 'submitting';

  const close = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && !isBusy && dialog.open) dialog.close();
  }, [isOpen, isBusy]);

  useEffect(() => {
    if (!isBusy) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [isBusy]);

  const stageFiles = useCallback((incomingFiles: File[]) => {
    if (busyRef.current) return;
    const audioFiles = incomingFiles.filter(isAudioFile);
    const skipped = incomingFiles.length - audioFiles.length;
    setSelectionMessage(
      skipped > 0
        ? `Skipped ${skipped} non-audio ${skipped === 1 ? 'file' : 'files'}.`
        : audioFiles.length === 0
          ? 'No audio files found. To add a folder, use Choose folder.'
          : ''
    );
    // Assign IDs outside the state updater so React can safely replay it.
    const additions: StagedFile[] = audioFiles.map((file) => ({
      id: nextId.current++,
      file,
      status: 'ready',
    }));
    setFiles((previous) => {
      const existing = new Set(previous.map((item) => fileIdentity(item.file)));
      return [
        ...previous,
        ...additions.filter((item) => {
          const identity = fileIdentity(item.file);
          if (existing.has(identity)) return false;
          existing.add(identity);
          return true;
        }),
      ];
    });
    setSource('files');
  }, []);

  useEffect(() => {
    if (
      !droppedFiles?.length ||
      droppedFiles === lastDroppedFiles.current ||
      isBusy
    )
      return;
    lastDroppedFiles.current = droppedFiles;
    stageFiles(droppedFiles);
    onDroppedFilesConsumed?.();
  }, [droppedFiles, isBusy, onDroppedFilesConsumed, stageFiles]);

  const readyFiles = files.filter((file) => file.status === 'ready');
  const failedFiles = files.filter((file) => file.status === 'error');
  const importedFiles = files.filter((file) => file.status === 'imported');
  const importFiles = async (selection: StagedFile[]) => {
    if (busyRef.current || selection.length === 0) return;
    busyRef.current = true;
    setIsImporting(true);
    setBatchProgress({ completed: 0, total: selection.length });
    setSelectionMessage('');
    const selectedIds = new Set(selection.map((file) => file.id));
    setFiles((previous) =>
      previous.map((file) =>
        selectedIds.has(file.id)
          ? { ...file, status: 'ready', error: undefined }
          : file
      )
    );
    let importedAny = false;
    try {
      for (const item of selection) {
        setFiles((previous) =>
          previous.map((file) =>
            file.id === item.id ? { ...file, status: 'importing' } : file
          )
        );
        try {
          const body = new FormData();
          body.append('file', item.file);
          const response = await fetch('/api/upload', { method: 'POST', body });
          if (!response.ok)
            throw new Error(
              (await responseMessage(response)) ||
                'Import failed. Please try again.'
            );
          const result: UploadResult = await response.json();
          importedAny = true;
          setFiles((previous) =>
            previous.map((file) =>
              file.id === item.id
                ? { ...file, status: 'imported', result, error: undefined }
                : file
            )
          );
        } catch (error) {
          setFiles((previous) =>
            previous.map((file) =>
              file.id === item.id
                ? {
                    ...file,
                    status: 'error',
                    error:
                      error instanceof Error
                        ? error.message
                        : 'Import failed. Please try again.',
                  }
                : file
            )
          );
        } finally {
          setBatchProgress((previous) => ({
            ...previous,
            completed: previous.completed + 1,
          }));
        }
      }
    } finally {
      if (importedAny)
        void queryClient.invalidateQueries({ queryKey: ['library'] });
      busyRef.current = false;
      setIsImporting(false);
    }
  };

  const queueDownload = async () => {
    if (busyRef.current) return;
    const trimmedUrl = url.trim();
    try {
      const parsed = new URL(trimmedUrl);
      if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error('Unsupported protocol');
    } catch {
      setDownloadStatus('error');
      setDownloadMessage(
        'Enter a complete link starting with https:// or http://.'
      );
      return;
    }
    busyRef.current = true;
    setDownloadStatus('submitting');
    setDownloadMessage('');
    try {
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmedUrl, dl_type: downloadType }),
      });
      const message = await responseMessage(response);
      if (!response.ok)
        throw new Error(
          message || 'Could not queue this link. Please try again.'
        );
      setDownloadStatus('queued');
      setDownloadMessage(message || 'Your download request was accepted.');
    } catch (error) {
      setDownloadStatus('error');
      setDownloadMessage(
        error instanceof Error
          ? error.message
          : 'Could not queue this link. Please try again.'
      );
    } finally {
      busyRef.current = false;
    }
  };

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    stageFiles(Array.from(event.dataTransfer.files));
  };

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (
      !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) ||
      isBusy
    )
      return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 'files'
        : event.key === 'End'
          ? 'url'
          : source === 'files'
            ? 'url'
            : 'files';
    setSource(next);
    (next === 'files' ? fileTabRef : urlTabRef).current?.focus();
  };

  return (
    <dialog
      ref={dialogRef}
      className="import-music"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={handleDrop}
    >
      <div className="import-music__body">
        <header className="import-music__header">
          <h2 id={titleId}>Import music</h2>
          <button
            className="import-music__close"
            type="button"
            onClick={close}
            disabled={isBusy}
            aria-label="Close import music"
          >
            <ImportIcon kind="close" />
          </button>
        </header>

        <div
          className="import-music__tabs"
          role="tablist"
          aria-label="Import source"
        >
          <button
            ref={fileTabRef}
            id={`${tabsId}-files`}
            type="button"
            role="tab"
            aria-selected={source === 'files'}
            aria-controls={`${tabsId}-files-panel`}
            tabIndex={source === 'files' ? 0 : -1}
            disabled={isBusy}
            onKeyDown={handleTabKey}
            onClick={() => setSource('files')}
          >
            Files
          </button>
          <button
            ref={urlTabRef}
            id={`${tabsId}-url`}
            type="button"
            role="tab"
            aria-selected={source === 'url'}
            aria-controls={`${tabsId}-url-panel`}
            tabIndex={source === 'url' ? 0 : -1}
            disabled={isBusy}
            onKeyDown={handleTabKey}
            onClick={() => setSource('url')}
          >
            Link
          </button>
        </div>

        <section
          className="import-music__panel"
          role="tabpanel"
          id={`${tabsId}-files-panel`}
          aria-labelledby={`${tabsId}-files`}
          hidden={source !== 'files'}
        >
          <input
            ref={filesInputRef}
            type="file"
            accept="audio/*,.mp3,.m4a,.flac,.wav,.ogg,.opus,.aac,.aiff,.alac,.wma,.m4b"
            multiple
            hidden
            disabled={isBusy}
            onChange={(event) => {
              stageFiles(Array.from(event.target.files || []));
              event.target.value = '';
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            hidden
            disabled={isBusy}
            {...{ webkitdirectory: '' }}
            onChange={(event) => {
              stageFiles(Array.from(event.target.files || []));
              event.target.value = '';
            }}
          />

          <div
            className={`import-music__dropzone${isDragging ? ' is-dragging' : ''}`}
            onDragEnter={(event) => {
              event.preventDefault();
              if (!isBusy) setIsDragging(true);
            }}
            onDragLeave={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null
                )
              )
                setIsDragging(false);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = isBusy ? 'none' : 'copy';
            }}
            onDrop={handleDrop}
          >
            <div className="import-music__choose">
              <button
                className="import-music__button"
                type="button"
                disabled={isBusy}
                onClick={() => filesInputRef.current?.click()}
              >
                Choose files
              </button>
              <button
                className="import-music__button"
                type="button"
                disabled={isBusy}
                onClick={() => folderInputRef.current?.click()}
              >
                Choose folder
              </button>
            </div>
            <p>{isDragging ? 'Drop to add files.' : 'Drop audio files here. Choose a folder to include subfolders.'}</p>
          </div>

          {selectionMessage && (
            <p className="import-music__notice" role="status">
              {selectionMessage}
            </p>
          )}

          {files.length > 0 && (
            <div className="import-music__selection">
              <div className="import-music__selection-heading">
                <div aria-live="polite" aria-atomic="true">
                  <h3>
                    {isImporting
                      ? `Importing ${Math.min(batchProgress.completed + 1, batchProgress.total)} of ${batchProgress.total}`
                      : importedFiles.length === files.length
                        ? 'Import complete'
                        : `${files.length} ${files.length === 1 ? 'file' : 'files'} selected`}
                  </h3>
                  <p>
                    {importedFiles.length > 0
                      ? `${importedFiles.length} imported · `
                      : ''}
                    {readyFiles.length > 0
                      ? `${readyFiles.length} ready · `
                      : ''}
                    {failedFiles.length > 0
                      ? `${failedFiles.length} failed · `
                      : ''}
                    {fileSize(
                      files.reduce((sum, item) => sum + item.file.size, 0)
                    )}
                  </p>
                </div>
                {!isBusy && (
                  <button
                    type="button"
                    className="import-music__text-button"
                    onClick={() => {
                      setFiles([]);
                      setSelectionMessage('');
                    }}
                  >
                    {importedFiles.length === files.length
                      ? 'Clear list'
                      : 'Clear selection'}
                  </button>
                )}
              </div>
              {isImporting && (
                <progress
                  className="import-music__progress"
                  value={batchProgress.completed}
                  max={batchProgress.total}
                  aria-label="Music import progress"
                />
              )}
              <ul
                className="import-music__file-list"
                aria-label="Selected audio files"
              >
                {files.map((item) => (
                  <li
                    key={item.id}
                    className={`import-music__file is-${item.status}`}
                  >
                    <div className="import-music__file-detail">
                      <strong
                        title={item.file.webkitRelativePath || item.file.name}
                      >
                        {item.result?.name || item.file.name}
                      </strong>
                      {item.error && <span>{item.error}</span>}
                    </div>
                    <span className="import-music__file-size">{fileSize(item.file.size)}</span>
                    <span className="import-music__file-status">
                      {item.status === 'importing' && <span className="import-music__spinner" aria-hidden="true" />}
                      {
                        {
                          ready: 'Ready',
                          importing: 'Importing…',
                          imported: 'Imported',
                          error: 'Failed',
                        }[item.status]
                      }
                    </span>
                    {item.status !== 'imported' && (
                      <button
                        type="button"
                        className="import-music__remove"
                        aria-label={`Remove ${item.file.name}`}
                        disabled={isBusy}
                        onClick={() =>
                          setFiles((previous) =>
                            previous.filter((file) => file.id !== item.id)
                          )
                        }
                      >
                        <ImportIcon kind="close" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <footer className="import-music__footer">
            <p>
              {isImporting
                ? 'Keep this window open until the import finishes.'
                : files.length === 0
                  ? 'No files selected'
                  : importedFiles.length > 0 &&
                      readyFiles.length === 0 &&
                      failedFiles.length === 0
                    ? `${importedFiles.length} imported`
                    : `${readyFiles.length} ready to import`}
            </p>
            <div className="import-music__actions">
              {!isBusy && failedFiles.length > 0 && (
                <button
                  className="import-music__button"
                  type="button"
                  onClick={() => void importFiles(failedFiles)}
                >
                  Retry {failedFiles.length} failed
                </button>
              )}
              {!isBusy && importedFiles.length > 0 && (
                <button
                  className={`import-music__button${readyFiles.length ? '' : ' import-music__button--solid'}`}
                  type="button"
                  onClick={() => {
                    onImported();
                    onClose();
                  }}
                >
                  View recent imports
                </button>
              )}
              {(readyFiles.length > 0 || isImporting || files.length === 0) && (
                <button
                  className="import-music__button import-music__button--solid"
                  type="button"
                  disabled={isBusy || readyFiles.length === 0}
                  onClick={() => void importFiles(readyFiles)}
                >
                  {isImporting
                    ? 'Importing…'
                    : readyFiles.length === 0 ? 'Import' : `Import ${readyFiles.length} ${readyFiles.length === 1 ? 'track' : 'tracks'}`}
                </button>
              )}
            </div>
          </footer>
        </section>

        <section
          className="import-music__panel"
          role="tabpanel"
          id={`${tabsId}-url-panel`}
          aria-labelledby={`${tabsId}-url`}
          hidden={source !== 'url'}
        >
          <form
            className="import-music__link-form"
            onSubmit={(event) => {
              event.preventDefault();
              void queueDownload();
            }}
          >
            <label className="import-music__label" htmlFor={urlId}>
              Music or video link
            </label>
            <input
              id={urlId}
              className="import-music__url"
              type="url"
              placeholder="https://…"
              value={url}
              disabled={isBusy}
              required
              autoComplete="off"
              onChange={(event) => {
                setUrl(event.target.value);
                setDownloadStatus('idle');
                setDownloadMessage('');
              }}
            />
            <fieldset
              className="import-music__download-types"
              disabled={isBusy}
            >
              <legend>Download as</legend>
              {(['Audio', 'Video'] as const).map((type) => (
                <label key={type}>
                  <input
                    type="radio"
                    name={`${tabsId}-download-type`}
                    value={type}
                    checked={downloadType === type}
                    onChange={() => {
                      setDownloadType(type);
                      setDownloadStatus('idle');
                      setDownloadMessage('');
                    }}
                  />
                  <span>{type === 'Audio' ? 'Audio only' : 'Video'}</span>
                </label>
              ))}
            </fieldset>
            {downloadStatus === 'queued' && (
              <div className="import-music__download-result" role="status">
                <ImportIcon kind="check" />
                <div>
                  <strong>Added to the download queue</strong>
                  <p>{downloadMessage}</p>
                  <p>
                    The track will appear in your library after processing.
                  </p>
                </div>
              </div>
            )}
            {downloadStatus === 'error' && (
              <p className="import-music__error" role="alert">
                {downloadMessage}
              </p>
            )}
            <footer className="import-music__footer">
              <p>Downloads run in the background.</p>
              <button
                className="import-music__button import-music__button--solid"
                type="submit"
                disabled={isBusy || !url.trim() || downloadStatus === 'queued'}
              >
                {downloadStatus === 'submitting'
                  ? 'Queuing…'
                  : downloadStatus === 'queued'
                    ? 'Queued'
                    : 'Queue download'}
              </button>
            </footer>
          </form>
        </section>
      </div>
    </dialog>
  );
}
