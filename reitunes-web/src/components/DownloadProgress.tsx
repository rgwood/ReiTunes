import { useState } from 'react';
import { isFinished, useDownloadJob } from '../hooks/useDownloads';
import './DownloadProgress.css';

export function DownloadProgress({ id, enabled = true, onRetry, onRestore, canRestore = true, onDismiss, onOpenLibrary }: {
  id: number;
  enabled?: boolean;
  onRetry: () => Promise<void>;
  onRestore?: () => Promise<void>;
  canRestore?: boolean;
  onDismiss?: () => void;
  onOpenLibrary?: () => void;
}) {
  const { data: job, error, refetch, isFetching } = useDownloadJob(id, enabled);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  const percent = job?.stage === 'downloading' && typeof job.download_percent === 'number'
    ? Math.min(100, Math.max(0, job.download_percent)) : undefined;
  const label = !job ? 'Checking download…' : {
    queued: 'Queued', downloading: percent === undefined ? 'Downloading…' : `Downloading ${Math.round(percent)}%`,
    processing: 'Converting…', uploading: 'Uploading…', importing: 'Adding to library…',
    completed: job.dl_type === 'Audio' ? 'Added to library' : 'Download complete', failed: 'Import failed',
  }[job.stage];
  return <div className="download-progress">
    <div className="download-progress__heading" role="status">{label}</div>
    {job && !isFinished(job) && <progress max={100} value={percent} aria-label="File download progress" />}
    {percent !== undefined && <small>Current file transfer · conversion and upload follow</small>}
    {job?.stage === 'failed' && <p className="download-progress__error" role="alert">{job.error || 'The download failed.'}</p>}
    {error && <p className="download-progress__error" role="alert">Progress unavailable. {error.message}</p>}
    {retryError && <p className="download-progress__error" role="alert">{retryError}</p>}
    <div className="download-progress__actions">
      {error && <button type="button" disabled={isFetching} onClick={() => void refetch()}>Check again</button>}
      {(job?.stage === 'failed' || (error?.status === 404 && onRestore)) && <button type="button" disabled={retrying} onClick={async () => {
        setRetrying(true); setRetryError('');
        try { await onRetry(); } catch (error) { setRetryError(error instanceof Error ? error.message : 'Could not retry import.'); }
        finally { setRetrying(false); }
      }}>{retrying ? 'Queuing…' : 'Retry import'}</button>}
      {onRestore && canRestore && (job?.stage === 'failed' || error?.status === 404) && <button type="button" disabled={retrying} onClick={async () => {
        setRetrying(true); setRetryError('');
        try { await onRestore(); } catch (error) { setRetryError(error instanceof Error ? error.message : 'Could not return this set to the inbox.'); }
        finally { setRetrying(false); }
      }}>Return to inbox</button>}
      {job?.stage === 'completed' && job.dl_type === 'Audio' && onOpenLibrary && <button type="button" onClick={onOpenLibrary}>View recent imports</button>}
      {onDismiss && (isFinished(job) || error?.status === 404) && <button type="button" onClick={onDismiss}>Dismiss</button>}
    </div>
  </div>;
}
