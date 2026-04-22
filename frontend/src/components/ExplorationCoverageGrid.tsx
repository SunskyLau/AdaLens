/**
 * Coverage Map.
 *
 * Controlled reusable grid:
 * - all cells are shown at once
 * - no scrolling axis controls
 * - top columns render insight-type glyphs
 * - left rows render dataset columns with total atomic counts
 * - color intensity only
 */

import { Fragment, useMemo, type CSSProperties } from 'react';
import clsx from 'clsx';

import {
  buildCoverageCellAverageImportanceStats,
  type CoverageGridModel,
} from './coverageGridModel';
import { InsightTypeGlyphMark } from './StorylineAtomicGlyph';
import type { StorylineFilterTriState, StorylineFilterViewModel } from './storylineFilter';
import { INSIGHT_TAXONOMY_COLORS, INSIGHT_TAXONOMY_FALLBACK_COLOR } from '@/config';
import type { InsightType } from '@/types';
import { buildCoverageCellMapKey } from '@/utils/coverageCellSelection';

export type CoverageGridColorMode = 'count' | 'avg_importance';

const DEFAULT_VISIBLE_ROW_COUNT = 11;
const COMPACT_ROW_HEIGHT_PX = 22;
const ROW_HEADER_MIN_WIDTH_PX = 96;
const ROW_HEADER_MAX_WIDTH_PX = 160;
const COVERAGE_HEADER_HEIGHT_PX = 36;
const COVERAGE_HEADER_COMPACT_HEIGHT_PX = 32;
const COVERAGE_HEADER_GLYPH_VIEWPORT_PX = 18;
const COVERAGE_HEADER_GLYPH_VIEWBOX_X = -7.5;
const COVERAGE_HEADER_GLYPH_VIEWBOX_Y = -11;
const COVERAGE_HEADER_GLYPH_VIEWBOX_WIDTH = 15;
const COVERAGE_HEADER_GLYPH_VIEWBOX_HEIGHT = 18;

function getCellBackground(value: number, maxValue: number, mode: CoverageGridColorMode) {
  if (value <= 0) return 'rgba(241, 245, 249, 1)';
  const intensity = Math.min(Math.max(value / Math.max(1e-6, maxValue), 0), 1);
  const alpha = mode === 'count'
    ? 0.15 + intensity * 0.85
    : 0.12 + intensity * 0.8;
  return mode === 'count'
    ? `rgba(37, 99, 235, ${alpha.toFixed(3)})`
    : `rgba(245, 158, 11, ${alpha.toFixed(3)})`;
}

function estimateRowHeaderWidthPx(labels: readonly string[]) {
  const longestLabelLength = labels.reduce(
    (maxLength, label) => Math.max(maxLength, label.length),
    'Clear All'.length
  );
  return Math.min(
    ROW_HEADER_MAX_WIDTH_PX,
    Math.max(ROW_HEADER_MIN_WIDTH_PX, Math.ceil(longestLabelLength * 6.6) + 34)
  );
}

function buildLegendGradient(maxValue: number, mode: CoverageGridColorMode) {
  const steps = 24;
  const stops: string[] = [];
  for (let idx = 0; idx <= steps; idx += 1) {
    const ratio = idx / steps;
    const value = ratio * maxValue;
    const position = (ratio * 100).toFixed(2);
    stops.push(`${getCellBackground(value, maxValue, mode)} ${position}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

function formatLegendEndpointValue(value: number, mode: CoverageGridColorMode) {
  if (mode === 'count') {
    return Math.round(value).toString();
  }
  if (Math.abs(value) < 1e-9) {
    return '0.00';
  }
  if (Math.abs(value) >= 100) {
    return value.toFixed(0);
  }
  if (Math.abs(value) >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

export interface ExplorationCoverageGridProps {
  model: CoverageGridModel;
  storylineFilter: StorylineFilterViewModel;
  colorMode: CoverageGridColorMode;
  onColorModeChange: (mode: CoverageGridColorMode) => void;
  emptyStateText?: string;
}

export default function ExplorationCoverageGrid({
  model,
  storylineFilter,
  colorMode,
  onColorModeChange,
  emptyStateText = 'No dataset schema columns',
}: ExplorationCoverageGridProps) {
  void onColorModeChange;
  const datasetColumns = model.axisColumns;
  const insightTypes = model.rows;
  const maxCount = Math.max(1, model.maxCount || 1);
  const { snapshot, actions } = storylineFilter;
  const selectedCellKeys = snapshot.selectedCellKeySet;

  const rowHeaderMinWidthPx = useMemo(
    () => estimateRowHeaderWidthPx(datasetColumns.map((axis) => axis.label)),
    [datasetColumns]
  );
  const headerHeight = insightTypes.length >= 10
    ? COVERAGE_HEADER_COMPACT_HEIGHT_PX
    : COVERAGE_HEADER_HEIGHT_PX;
  const rowTrackSize = datasetColumns.length > DEFAULT_VISIBLE_ROW_COUNT
    ? `${COMPACT_ROW_HEIGHT_PX}px`
    : `max(${COMPACT_ROW_HEIGHT_PX}px, calc((100% - ${headerHeight}px) / ${DEFAULT_VISIBLE_ROW_COUNT}))`;
  const averageImportanceStats = useMemo(
    () => buildCoverageCellAverageImportanceStats(model),
    [model]
  );
  const atomicCountByColumn = useMemo(() => {
    const counts = new Map<string, number>();
    for (const axis of datasetColumns) {
      const atomicKeys = new Set<string>();
      for (const cellKey of model.columnKeys.get(axis.label) ?? []) {
        for (const atomicKey of model.cellMetaByKey.get(cellKey)?.atomicKeys ?? []) {
          atomicKeys.add(atomicKey);
        }
      }
      counts.set(axis.label, atomicKeys.size);
    }
    return counts;
  }, [datasetColumns, model.cellMetaByKey, model.columnKeys]);
  const averageLegendVisualMax = averageImportanceStats.maxAverageImportance > 0
    ? averageImportanceStats.maxAverageImportance
    : 1;
  const legendMax = colorMode === 'count' ? maxCount : averageLegendVisualMax;
  const legendGradient = useMemo(
    () => buildLegendGradient(legendMax, colorMode),
    [colorMode, legendMax]
  );
  const legendTitle = colorMode === 'count' ? 'Count' : 'Importance';
  const legendMinLabel = formatLegendEndpointValue(0, colorMode);
  const legendMaxLabel = formatLegendEndpointValue(
    colorMode === 'count' ? maxCount : averageImportanceStats.maxAverageImportance,
    colorMode
  );

  const resolveHeaderButtonClassName = (state: StorylineFilterTriState) =>
    state === 'all'
      ? 'bg-blue-50'
      : state === 'partial'
        ? 'bg-blue-50/70'
        : 'bg-white hover:bg-slate-50';

  const resolveRowButtonClassName = (state: StorylineFilterTriState) =>
    state === 'all'
      ? 'bg-blue-50 text-blue-700'
      : state === 'partial'
        ? 'bg-blue-50/70 text-blue-600'
        : 'bg-white text-slate-700 hover:bg-slate-50';

  const gridStyle: CSSProperties = {
    display: 'grid',
    width: '100%',
    minHeight: '100%',
    alignContent: 'start',
    gridTemplateColumns: `${rowHeaderMinWidthPx}px repeat(${Math.max(1, insightTypes.length)}, minmax(0, 1fr))`,
    gridTemplateRows: `${headerHeight}px repeat(${datasetColumns.length}, ${rowTrackSize})`,
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-white">
      <div className="border-b border-slate-200 bg-slate-50/70 px-3 py-2">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-medium text-slate-500">
            {legendTitle}
          </span>
          <span className="text-[10px] tabular-nums text-slate-600">{legendMinLabel}</span>
          <div className="min-w-[120px] flex-1">
            <div
              className="h-2.5 w-full rounded-full border border-slate-300/90"
              style={{ background: legendGradient }}
            />
          </div>
          <span className="text-[10px] tabular-nums text-slate-600">{legendMaxLabel}</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 p-2">
        {datasetColumns.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center rounded-md border border-slate-200 bg-slate-50/60 text-xs text-slate-400">
            {emptyStateText}
          </div>
        ) : (
          <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden">
            <div style={gridStyle}>
              <div
                className="flex items-center border border-r-slate-300 border-slate-200 bg-white px-2"
                style={{ height: headerHeight }}
              >
                <button
                  type="button"
                  onClick={() => actions.clearAll()}
                  disabled={!snapshot.hasActiveFilter}
                  aria-label="Clear all filter selections"
                  className={clsx(
                    'inline-flex w-full items-center justify-center rounded-md px-2 py-1 text-[10px] font-semibold transition',
                    snapshot.hasActiveFilter
                      ? 'text-slate-700 hover:bg-slate-100'
                      : 'text-slate-300'
                  )}
                >
                  Clear All
                </button>
              </div>

              {insightTypes.map((insightType) => {
                const headerState = snapshot.rowStates.get(insightType.id) ?? 'none';
                const glyphColor = INSIGHT_TAXONOMY_COLORS[insightType.id]?.hex
                  || INSIGHT_TAXONOMY_FALLBACK_COLOR.hex;
                const glyphOpacity = headerState === 'all'
                  ? 1
                  : headerState === 'partial'
                    ? 0.82
                    : snapshot.hasActiveFilter
                      ? 0.42
                      : 0.94;
                return (
                  <button
                    key={`taxonomy-${insightType.id}`}
                    type="button"
                    onClick={() => actions.toggleRow(insightType.id)}
                    aria-label={`Toggle filter insight type ${insightType.label}`}
                    className={clsx(
                      'flex items-center justify-center border border-l-0 border-slate-200 px-1 transition-colors',
                      resolveHeaderButtonClassName(headerState)
                    )}
                    style={{ height: headerHeight }}
                    title={insightType.label}
                  >
                    <svg
                      width={COVERAGE_HEADER_GLYPH_VIEWPORT_PX}
                      height={COVERAGE_HEADER_GLYPH_VIEWPORT_PX}
                      viewBox={`${COVERAGE_HEADER_GLYPH_VIEWBOX_X} ${COVERAGE_HEADER_GLYPH_VIEWBOX_Y} ${COVERAGE_HEADER_GLYPH_VIEWBOX_WIDTH} ${COVERAGE_HEADER_GLYPH_VIEWBOX_HEIGHT}`}
                      aria-hidden="true"
                      className="shrink-0"
                      style={{ opacity: glyphOpacity }}
                    >
                      <InsightTypeGlyphMark
                        insightType={insightType.id as InsightType}
                        size={12}
                        color={glyphColor}
                      />
                    </svg>
                  </button>
                );
              })}

              {datasetColumns.map((axis) => {
                const columnState = snapshot.columnStates.get(axis.label) ?? 'none';
                const atomicCount = atomicCountByColumn.get(axis.label) ?? 0;
                return (
                  <Fragment key={`column-${axis.key}`}>
                    <button
                      type="button"
                      onClick={() => actions.toggleColumn(axis.label)}
                      aria-label={`Toggle filter column ${axis.label}`}
                      className={clsx(
                        'flex items-center border border-r-slate-300 border-slate-200 border-t-0 px-2 text-left transition-colors',
                        resolveRowButtonClassName(columnState)
                      )}
                      title={axis.label}
                    >
                      <div className="flex w-full min-w-0 items-baseline justify-between gap-2">
                        <div className="min-w-0 truncate whitespace-nowrap text-[10px] font-medium leading-tight text-current">
                          {axis.label}
                        </div>
                        <div className="shrink-0 text-[10px] tabular-nums text-slate-400">
                          ({atomicCount})
                        </div>
                      </div>
                    </button>

                    {insightTypes.map((insightType) => {
                      const key = buildCoverageCellMapKey(insightType.id, axis.label);
                      const cell = model.cellMetaByKey.get(key);
                      const count = cell?.atomicKeys.length || 0;
                      const averageImportance = averageImportanceStats.averageByCellKey.get(key) ?? 0;
                      const selected = selectedCellKeys.has(key);
                      const colorValue = colorMode === 'count' ? count : averageImportance;

                      return (
                        <button
                          key={`c-${insightType.id}-${axis.key}`}
                          type="button"
                          onClick={() => actions.toggleCell(insightType.id, axis.label)}
                          aria-label={`Toggle filter cell ${insightType.label} x ${axis.label}`}
                          className={clsx(
                            'cursor-pointer border border-l-0 border-slate-200 border-t-0 transition-colors hover:border-blue-300 focus:outline-none',
                            selected && 'ring-2 ring-inset ring-blue-500'
                          )}
                          style={{
                            background: getCellBackground(colorValue, legendMax, colorMode),
                          }}
                          title={`${insightType.label} x ${axis.label}\n${count} atomic insight${count === 1 ? '' : 's'}\nAvg. Importance ${averageImportance.toFixed(2)}`}
                        />
                      );
                    })}
                  </Fragment>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
