import { useEffect, useMemo, useState } from 'react';
import { Hash, Loader2, Tag } from 'lucide-react';
import { fetchDatasetPreview } from '@/api/client';
import {
  DATA_VIEW_CELL_WIDTH_PX,
  DATA_VIEW_MAX_CELL_CHARS,
  DATA_VIEW_PREVIEW_ROWS,
  WORKSPACE_PANEL_HEADER_HEIGHT_PX,
} from '@/config';
import type { DatasetPreviewResponse } from '@/types';
import { getColumnKind, parseDatasetSchemaColumnKinds, type ColumnKind } from '@/utils/datasetSchema';

interface DataViewProps {
  runId: string;
  datasetPath: string;
  datasetSchema: string;
}

function toFilename(datasetPath: string): string {
  if (!datasetPath) return '';
  const normalized = datasetPath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function formatCellValue(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= DATA_VIEW_MAX_CELL_CHARS) {
    return singleLine;
  }
  return `${singleLine.slice(0, DATA_VIEW_MAX_CELL_CHARS)}...`;
}

function ColumnKindIcon({ kind }: { kind: ColumnKind }) {
  if (kind === 'number') {
    return <Hash className="w-3 h-3 text-slate-400 flex-shrink-0" aria-hidden="true" />;
  }
  return <Tag className="w-3 h-3 text-slate-400 flex-shrink-0" aria-hidden="true" />;
}

export default function DataView({ runId, datasetPath, datasetSchema }: DataViewProps) {
  const [preview, setPreview] = useState<DatasetPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const columnKinds = useMemo(() => parseDatasetSchemaColumnKinds(datasetSchema), [datasetSchema]);

  useEffect(() => {
    setPageIndex(0);
  }, [runId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const offset = pageIndex * DATA_VIEW_PREVIEW_ROWS;

    fetchDatasetPreview(runId, DATA_VIEW_PREVIEW_ROWS, offset)
      .then((resp) => {
        if (cancelled) return;
        setPreview(resp);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Failed to load dataset preview';
        setError(message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [runId, pageIndex]);

  const sourceName = useMemo(() => toFilename(datasetPath), [datasetPath]);
  const totalPages = preview ? Math.max(1, Math.ceil(preview.row_count / DATA_VIEW_PREVIEW_ROWS)) : 1;
  const canGoPrev = pageIndex > 0 && !loading;
  const canGoNext = !!preview?.has_more && !loading;
  const startRow = preview && preview.returned_rows > 0 ? preview.offset + 1 : 0;
  const endRow = preview ? preview.offset + preview.returned_rows : 0;

  return (
    <div className="h-full flex flex-col">
      <div
        className="flex-none px-3 border-b border-slate-100 flex items-center"
        style={{ height: `${WORKSPACE_PANEL_HEADER_HEIGHT_PX}px` }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="font-medium text-slate-700 text-sm">Data View</h2>
          <p
            className="min-w-0 text-[11px] text-slate-400 truncate"
            title={datasetPath}
          >
            {sourceName || datasetPath}
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {loading && (
          <div className="h-full flex items-center justify-center text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        )}

        {!loading && error && (
          <div className="p-3 text-xs text-red-500">{error}</div>
        )}

        {!loading && !error && (!preview || preview.columns.length === 0) && (
          <div className="p-3 text-xs text-slate-400">No tabular preview available.</div>
        )}

        {!loading && !error && preview && preview.columns.length > 0 && (
          <div className="min-w-max">
            <table className="text-xs table-fixed">
              <thead className="sticky top-0 bg-slate-50 z-10">
                <tr className="border-b border-slate-200">
                  <th className="sticky left-0 top-0 z-20 px-2 py-1.5 text-left font-medium text-slate-500 w-10 bg-slate-50 border-r border-slate-200">
                    #
                  </th>
                  {preview.columns.map((column, idx) => {
                    const kind = getColumnKind(column, columnKinds);
                    return (
                      <th
                        key={`${column}-${idx}`}
                        className="px-2 py-1.5 text-left font-medium text-slate-600 whitespace-nowrap overflow-hidden text-ellipsis"
                        style={{
                          width: DATA_VIEW_CELL_WIDTH_PX,
                          minWidth: DATA_VIEW_CELL_WIDTH_PX,
                          maxWidth: DATA_VIEW_CELL_WIDTH_PX,
                        }}
                        title={`${column} (${kind})`}
                      >
                        <div className="flex items-center gap-1 min-w-0">
                          <span className="truncate">{column}</span>
                          <ColumnKindIcon kind={kind} />
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, rowIdx) => (
                  <tr key={`row-${rowIdx}`} className="border-b border-slate-100">
                    <td className="sticky left-0 z-10 px-2 py-1.5 text-slate-400 align-top bg-white border-r border-slate-100">
                      {preview.offset + rowIdx + 1}
                    </td>
                    {row.map((cell, colIdx) => (
                      <td
                        key={`cell-${rowIdx}-${colIdx}`}
                        className="px-2 py-1.5 text-slate-600 align-top whitespace-nowrap overflow-hidden text-ellipsis truncate"
                        style={{
                          width: DATA_VIEW_CELL_WIDTH_PX,
                          minWidth: DATA_VIEW_CELL_WIDTH_PX,
                          maxWidth: DATA_VIEW_CELL_WIDTH_PX,
                        }}
                        title={cell}
                      >
                        {formatCellValue(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!loading && !error && preview && (
        <div className="flex-none px-3 py-2 border-t border-slate-100 text-[11px] text-slate-400">
          <div className="flex items-center justify-between gap-2">
            <div>
              Rows {startRow}-{endRow} / {preview.row_count}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPageIndex(0)}
                disabled={!canGoPrev}
                className="px-2 py-0.5 border border-slate-200 rounded text-slate-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                First
              </button>
              <button
                type="button"
                onClick={() => setPageIndex((v) => Math.max(0, v - 1))}
                disabled={!canGoPrev}
                title="Previous page"
                aria-label="Previous page"
                className="px-2 py-0.5 border border-slate-200 rounded text-slate-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ←
              </button>
              <span className="px-1 text-slate-500">
                {pageIndex + 1} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPageIndex((v) => v + 1)}
                disabled={!canGoNext}
                title="Next page"
                aria-label="Next page"
                className="px-2 py-0.5 border border-slate-200 rounded text-slate-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                →
              </button>
              <button
                type="button"
                onClick={() => setPageIndex(Math.max(0, totalPages - 1))}
                disabled={!canGoNext}
                className="px-2 py-0.5 border border-slate-200 rounded text-slate-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Last
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
