import { useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

interface UploadResponse {
  id: string;
  name: string;
  artist: string | null;
  album: string | null;
  file_path: string;
}

interface FileUploadState {
  file: File;
  status: 'pending' | 'uploading' | 'success' | 'error';
  result?: UploadResponse;
  error?: string;
}

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function UploadModal({ isOpen, onClose }: UploadModalProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploads, setUploads] = useState<FileUploadState[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const resetState = useCallback(() => {
    setUploads([]);
  }, []);

  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [resetState, onClose]);

  const uploadSingleFile = async (file: File): Promise<{ result?: UploadResponse; error?: string }> => {
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const text = await response.text();
        return { error: text || 'Upload failed' };
      }

      const data: UploadResponse = await response.json();
      return { result: data };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Upload failed' };
    }
  };

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);

    // Initialize upload states
    const initialStates: FileUploadState[] = fileArray.map(file => ({
      file,
      status: 'pending',
    }));
    setUploads(initialStates);

    // Upload files sequentially
    for (let i = 0; i < fileArray.length; i++) {
      // Mark current file as uploading
      setUploads(prev => prev.map((u, idx) =>
        idx === i ? { ...u, status: 'uploading' } : u
      ));

      const { result, error } = await uploadSingleFile(fileArray[i]);

      // Update with result
      setUploads(prev => prev.map((u, idx) =>
        idx === i ? {
          ...u,
          status: error ? 'error' : 'success',
          result,
          error,
        } : u
      ));
    }

    // Refresh library after all uploads complete
    queryClient.invalidateQueries({ queryKey: ['library'] });
  }, [queryClient]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      uploadFiles(files);
    }
  }, [uploadFiles]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      uploadFiles(files);
    }
    // Reset input so same files can be selected again
    e.target.value = '';
  }, [uploadFiles]);

  const handleBrowseClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  if (!isOpen) return null;

  const isUploading = uploads.some(u => u.status === 'uploading' || u.status === 'pending');
  const successCount = uploads.filter(u => u.status === 'success').length;
  const errorCount = uploads.filter(u => u.status === 'error').length;
  const totalCount = uploads.length;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-solarized-base02 border border-solarized-blue rounded-lg p-6 w-[500px] max-w-full max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg text-solarized-base1">Upload Music</h2>
          <button
            onClick={handleClose}
            className="text-solarized-base01 hover:text-solarized-base1"
          >
            &#10005;
          </button>
        </div>

        {/* Drop zone */}
        <div
          className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            isDragging
              ? 'border-solarized-blue bg-solarized-blue bg-opacity-10'
              : 'border-solarized-base01'
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />

          {uploads.length === 0 ? (
            <>
              <div className="text-solarized-base01 mb-2">
                Drop audio files here
              </div>
              <div className="text-solarized-base00 text-sm mb-4">or</div>
              <button
                onClick={handleBrowseClick}
                className="px-4 py-2 bg-solarized-blue text-solarized-base03 rounded hover:bg-solarized-cyan transition-colors"
              >
                Browse Files
              </button>
            </>
          ) : (
            <div className="text-left">
              {/* Progress summary */}
              {isUploading && (
                <div className="mb-4 text-solarized-base1">
                  Uploading {successCount + errorCount + 1} of {totalCount}...
                </div>
              )}
              {!isUploading && (
                <div className="mb-4">
                  <span className="text-solarized-green">{successCount} uploaded</span>
                  {errorCount > 0 && (
                    <span className="text-solarized-red ml-2">{errorCount} failed</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* File list */}
        {uploads.length > 0 && (
          <div className="mt-4 flex-1 overflow-y-auto max-h-64">
            {uploads.map((upload, idx) => (
              <div
                key={idx}
                className="flex items-center gap-2 py-2 border-b border-solarized-base02 last:border-0"
              >
                {/* Status icon */}
                <div className="w-6 text-center">
                  {upload.status === 'pending' && (
                    <span className="text-solarized-base01">&#8230;</span>
                  )}
                  {upload.status === 'uploading' && (
                    <span className="text-solarized-blue animate-pulse">&#8635;</span>
                  )}
                  {upload.status === 'success' && (
                    <span className="text-solarized-green">&#10003;</span>
                  )}
                  {upload.status === 'error' && (
                    <span className="text-solarized-red">&#10007;</span>
                  )}
                </div>

                {/* File info */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-solarized-base1 truncate">
                    {upload.result?.name || upload.file.name}
                  </div>
                  {upload.result?.artist && (
                    <div className="text-xs text-solarized-base01 truncate">
                      {upload.result.artist}
                    </div>
                  )}
                  {upload.error && (
                    <div className="text-xs text-solarized-red truncate">
                      {upload.error}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="mt-4 flex justify-end gap-2">
          {uploads.length > 0 && !isUploading && (
            <button
              onClick={resetState}
              className="px-4 py-2 bg-solarized-blue text-solarized-base03 rounded hover:bg-solarized-cyan transition-colors"
            >
              Upload More
            </button>
          )}
          <button
            onClick={handleClose}
            disabled={isUploading}
            className={`px-4 py-2 rounded transition-colors ${
              isUploading
                ? 'bg-solarized-base01 text-solarized-base00 cursor-not-allowed'
                : 'bg-solarized-base01 text-solarized-base03 hover:bg-solarized-base00'
            }`}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
