import { useRef, type FormEvent, type KeyboardEvent } from 'react';
import { Loader2, SendHorizonal, Upload } from 'lucide-react';

export function resolvePromptInputEnterBehavior(args: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}): 'submit' | 'newline' | 'ignore' {
  const { key, shiftKey, ctrlKey, metaKey, altKey, isComposing = false } = args;
  if (key !== 'Enter' || isComposing) {
    return 'ignore';
  }
  if (shiftKey || ctrlKey || metaKey || altKey) {
    return 'newline';
  }
  return 'submit';
}

export default function SteerInput({
  value,
  onChange,
  onSubmit,
  disabled,
  isSending,
  error,
  placeholder,
  mode = 'run',
  datasetPath: _datasetPath,
  onDatasetPathChange: _onDatasetPathChange,
  onUploadDataset,
  datasetError,
  uploadedDatasetName,
  uploadedDatasetSizeBytes,
  isUploadingDataset,
  lockDatasetSource = false,
  preserveDatasetSourceStyle: _preserveDatasetSourceStyle = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  disabled: boolean;
  isSending: boolean;
  error: string | null;
  placeholder?: string;
  mode?: 'run' | 'new';
  datasetPath?: string;
  onDatasetPathChange?: (value: string) => void;
  onUploadDataset?: (file: File) => Promise<void> | void;
  datasetError: string | null;
  uploadedDatasetName: string | null;
  uploadedDatasetSizeBytes: number | null;
  isUploadingDataset: boolean;
  lockDatasetSource?: boolean;
  preserveDatasetSourceStyle?: boolean;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isDatasetEditable = mode === 'new' && !lockDatasetSource;

  function formatBytes(sizeBytes: number | null): string | null {
    if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
      return null;
    }
    if (sizeBytes < 1024) {
      return `${sizeBytes} B`;
    }
    if (sizeBytes < 1024 * 1024) {
      return `${(sizeBytes / 1024).toFixed(1)} KB`;
    }
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const uploadedDatasetSizeLabel = formatBytes(uploadedDatasetSizeBytes);

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const behavior = resolvePromptInputEnterBehavior({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      isComposing: event.nativeEvent.isComposing,
    });
    if (behavior !== 'submit') {
      return;
    }
    event.preventDefault();
    if (disabled || isSending || isUploadingDataset) {
      return;
    }
    formRef.current?.requestSubmit();
  };

  const datasetStatus = uploadedDatasetName
    ? `Selected file: ${uploadedDatasetName}${uploadedDatasetSizeLabel ? ` (${uploadedDatasetSizeLabel})` : ''}`
    : null;

  return (
    <div className="border-t border-slate-200 bg-white px-2 py-2">
      <form ref={formRef} onSubmit={onSubmit} className="space-y-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) {
              return;
            }
            void onUploadDataset?.(file);
            event.currentTarget.value = '';
          }}
        />

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 transition focus-within:border-sky-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-sky-100">
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handlePromptKeyDown}
            disabled={disabled}
            placeholder={
              placeholder ??
              (mode === 'new'
                ? 'Describe the analysis goal you want to start...'
                : 'Guide the master agent, ask a follow-up question, or redirect the analysis...')
            }
            className="min-h-[84px] w-full resize-none bg-transparent px-4 pb-2 pt-3 text-sm text-slate-700 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div
            data-steer-control-row="true"
            className="flex items-center justify-between px-3 pb-2"
          >
            <button
              type="button"
              data-steer-upload-button="true"
              disabled={!isDatasetEditable || isUploadingDataset}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-800 text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
              title={isUploadingDataset ? 'Uploading dataset...' : 'Upload CSV'}
              aria-label={isUploadingDataset ? 'Uploading dataset...' : 'Upload CSV'}
            >
              {isUploadingDataset ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="submit"
              disabled={disabled || isSending || isUploadingDataset}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-800 text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
              title={isSending ? 'Sending...' : mode === 'new' ? 'Start conversation' : 'Send'}
            >
              {isSending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <SendHorizonal className="-rotate-90 h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        {(datasetStatus || datasetError) && (
          <div className="flex flex-col gap-1 px-1 text-xs">
            {datasetStatus ? (
              <div className="text-emerald-700">
                Selected file: <span className="font-medium">{uploadedDatasetName}</span>
                {uploadedDatasetSizeLabel ? ` (${uploadedDatasetSizeLabel})` : ''}
              </div>
            ) : null}
            {datasetError ? (
              <div className="text-rose-600">{datasetError}</div>
            ) : null}
          </div>
        )}
      </form>
      {error && <div className="mt-1.5 text-xs text-rose-600">{error}</div>}
    </div>
  );
}

