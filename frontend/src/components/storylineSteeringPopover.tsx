import {
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from 'react';

import SteeringCardTitle from '@/components/SteeringCardTitle';
import { getSoftSteeringDisplayLabel } from '@/steering/kinds';
import {
  buildSteeringParentSummaryPreviewLabel,
  buildSteeringTargetPreviewLabel,
  normalizeEditableSteeringPreview,
  normalizeSteeringKeywords,
} from '@/steering/prompt';
import type { SteeringTargetSnapshot } from '@/types';

const STORYLINE_POPOVER_PADDING_PX = 8;
const STORYLINE_STEERING_POPOVER_WIDTH_PX = 384;
const STORYLINE_STEERING_POPOVER_MIN_VISIBLE_HEIGHT_PX = 168;
const STORYLINE_STEERING_KEYWORD_POPOVER_ESTIMATED_HEIGHT_PX = 392;
const STORYLINE_STEERING_COLUMN_POPOVER_ESTIMATED_HEIGHT_PX = 276;
const STORYLINE_STEERING_TARGET_POPOVER_ESTIMATED_BASE_HEIGHT_PX = 264;

export interface StorylineSteeringPopoverState {
  kind: 'focus' | 'ignore' | 'elaborate';
  target: SteeringTargetSnapshot;
  x: number;
  y: number;
  selectedKeywords: string[];
  userPromptDraft: string;
  generatedPreviewBase: string;
  userPromptSuffix: string;
  backgroundText: string;
  includeBackground: boolean;
  error: string | null;
}

interface StorylineSteeringPopoverProps {
  popover: StorylineSteeringPopoverState;
  viewport: { width: number; height: number };
  keywordOptions: readonly string[];
  isSubmitting: boolean;
  isConfirmDisabled?: boolean;
  previewPlaceholder?: string;
  chipActiveClassName: string;
  chipIdleClassName: string;
  popoverRef?: Ref<HTMLDivElement>;
  isDraggable?: boolean;
  onKeywordToggle: (keyword: string) => void;
  onUserPromptChange: (value: string) => void;
  onIncludeBackgroundChange: (checked: boolean) => void;
  onPopoverMouseDown?: (
    event: ReactMouseEvent<HTMLDivElement>,
    position: { left: number; top: number }
  ) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export interface StorylineSteeringPreviewSegment {
  text: string;
  highlighted: boolean;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function getTargetSectionTitle(target: SteeringTargetSnapshot): 'Target' | 'Column' {
  return target.kind === 'column' ? 'Column' : 'Target';
}

function getTargetLeadText(target: SteeringTargetSnapshot): string {
  if (target.kind === 'column') {
    return '';
  }
  const summaryLabel = target.summary_short_label.trim();
  if (summaryLabel) {
    return summaryLabel;
  }
  if (target.kind === 'atomic') {
    return target.atomic_text?.trim() || target.atomic_id || target.summary_id;
  }
  return target.summary_id;
}

function getTargetBodyText(target: SteeringTargetSnapshot, kind: StorylineSteeringPopoverState['kind']): string {
  if (target.kind === 'column') {
    return '';
  }
  if (target.kind === 'atomic') {
    return target.atomic_text?.trim() || target.summary_text.trim();
  }
  if (kind === 'elaborate') {
    return '';
  }
  return target.summary_text.trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeHighlightTokens(tokens: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawToken of tokens) {
    const token = String(rawToken ?? '').trim();
    if (!token) {
      continue;
    }
    const lookupKey = token.toLocaleLowerCase();
    if (seen.has(lookupKey)) {
      continue;
    }
    seen.add(lookupKey);
    normalized.push(token);
  }
  return normalized.sort((left, right) => right.length - left.length);
}

function resolvePreviewPrefixAndSuffix(
  popover: Pick<
    StorylineSteeringPopoverState,
    'generatedPreviewBase' | 'userPromptDraft' | 'userPromptSuffix'
  >
): { prefix: string; suffix: string } {
  const draft = normalizeEditableSteeringPreview(popover.userPromptDraft);
  if (!draft) {
    return { prefix: '', suffix: '' };
  }
  const suffix = normalizeEditableSteeringPreview(popover.userPromptSuffix);
  if (suffix) {
    const suffixWithSeparator = `\n${suffix}`;
    if (draft.endsWith(suffixWithSeparator)) {
      return {
        prefix: draft.slice(0, -suffixWithSeparator.length),
        suffix: suffixWithSeparator,
      };
    }
    if (draft.endsWith(suffix)) {
      return {
        prefix: draft.slice(0, -suffix.length),
        suffix,
      };
    }
  }
  const generatedPreviewBase = normalizeEditableSteeringPreview(popover.generatedPreviewBase);
  if (generatedPreviewBase && draft.startsWith(generatedPreviewBase)) {
    return {
      prefix: generatedPreviewBase,
      suffix: draft.slice(generatedPreviewBase.length),
    };
  }
  return {
    prefix: draft,
    suffix: '',
  };
}

function resolvePreviewHighlightTokens(
  popover: Pick<StorylineSteeringPopoverState, 'kind' | 'target' | 'selectedKeywords'>
): string[] {
  const tokens: string[] = [];
  if (popover.target.kind === 'column') {
    tokens.push(...popover.target.columns);
  } else {
    const summaryLabel = buildSteeringParentSummaryPreviewLabel(popover.target);
    if (summaryLabel) {
      tokens.push(summaryLabel);
    }
    if (popover.target.kind === 'atomic') {
      const atomicLabel = buildSteeringTargetPreviewLabel(popover.target);
      if (atomicLabel) {
        tokens.push(atomicLabel);
      }
    }
  }
  if (doesStorylineSteeringPopoverRequireKeywords(popover)) {
    tokens.push(...normalizeSteeringKeywords(popover.selectedKeywords));
  }
  return normalizeHighlightTokens(tokens);
}

function getPreviewHighlightClassName(kind: StorylineSteeringPopoverState['kind']): string {
  if (kind === 'ignore') {
    return 'font-semibold text-rose-700';
  }
  if (kind === 'elaborate') {
    return 'font-semibold text-sky-700';
  }
  return 'font-semibold text-amber-700';
}

export function buildStorylineSteeringPreviewSegments(
  popover: Pick<
    StorylineSteeringPopoverState,
    'kind' | 'target' | 'selectedKeywords' | 'generatedPreviewBase' | 'userPromptDraft' | 'userPromptSuffix'
  >
): StorylineSteeringPreviewSegment[] {
  const draft = normalizeEditableSteeringPreview(popover.userPromptDraft);
  if (!draft) {
    return [];
  }
  const { prefix, suffix } = resolvePreviewPrefixAndSuffix(popover);
  const highlightTokens = resolvePreviewHighlightTokens(popover);
  if (!prefix || highlightTokens.length === 0) {
    return [{ text: draft, highlighted: false }];
  }
  const pattern = new RegExp(highlightTokens.map((token) => escapeRegExp(token)).join('|'), 'g');
  const segments: StorylineSteeringPreviewSegment[] = [];
  let lastIndex = 0;
  for (const match of prefix.matchAll(pattern)) {
    const matchIndex = match.index ?? -1;
    const matchText = match[0] ?? '';
    if (matchIndex < lastIndex || !matchText) {
      continue;
    }
    if (matchIndex > lastIndex) {
      segments.push({
        text: prefix.slice(lastIndex, matchIndex),
        highlighted: false,
      });
    }
    segments.push({
      text: matchText,
      highlighted: true,
    });
    lastIndex = matchIndex + matchText.length;
  }
  if (lastIndex < prefix.length) {
    segments.push({
      text: prefix.slice(lastIndex),
      highlighted: false,
    });
  }
  if (suffix) {
    segments.push({
      text: suffix,
      highlighted: false,
    });
  }
  return segments.filter((segment) => segment.text.length > 0);
}

function estimateWrappedLineCount(text: string, charsPerLine: number): number {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return 0;
  }
  return normalizedText
    .split(/\r?\n/)
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
}

export function doesStorylineSteeringPopoverRequireKeywords(
  popover: Pick<StorylineSteeringPopoverState, 'kind' | 'target'>
): boolean {
  return popover.kind !== 'elaborate' && popover.target.kind !== 'column';
}

export function doesStorylineSteeringPopoverRequireBackground(
  popover: Pick<StorylineSteeringPopoverState, 'kind' | 'target'>
): boolean {
  return popover.kind !== 'elaborate' && popover.target.kind !== 'column';
}

export function estimateStorylineSteeringPopoverHeight(
  popover: Pick<
    StorylineSteeringPopoverState,
    'kind' | 'target' | 'error' | 'userPromptDraft' | 'backgroundText'
  >
): number {
  const previewLineCount = estimateWrappedLineCount(popover.userPromptDraft, 42);
  const backgroundLineCount = estimateWrappedLineCount(popover.backgroundText, 42);
  if (doesStorylineSteeringPopoverRequireKeywords(popover)) {
    return STORYLINE_STEERING_KEYWORD_POPOVER_ESTIMATED_HEIGHT_PX
      + previewLineCount * 18
      + backgroundLineCount * 18
      + (popover.error ? 28 : 0);
  }
  if (popover.target.kind === 'column') {
    const estimatedColumnRows = Math.max(1, Math.ceil(popover.target.columns.length / 2));
    return STORYLINE_STEERING_COLUMN_POPOVER_ESTIMATED_HEIGHT_PX
      + (estimatedColumnRows - 1) * 32
      + previewLineCount * 18
      + (popover.error ? 28 : 0);
  }
  const targetBodyText = getTargetBodyText(popover.target, popover.kind);
  const targetBodyLineCount = estimateWrappedLineCount(targetBodyText, 38);
  return STORYLINE_STEERING_TARGET_POPOVER_ESTIMATED_BASE_HEIGHT_PX
    + targetBodyLineCount * 18
    + previewLineCount * 18
    + (popover.error ? 28 : 0);
}

export function resolveStorylineSteeringPopoverPosition(args: {
  popover: Pick<
    StorylineSteeringPopoverState,
    'kind' | 'target' | 'x' | 'y' | 'error' | 'userPromptDraft' | 'backgroundText'
  >;
  viewport: { width: number; height: number };
}): {
  left: number;
  top: number;
  estimatedHeightPx: number;
} {
  const estimatedHeightPx = estimateStorylineSteeringPopoverHeight(args.popover);
  const layout = resolveStorylineSteeringPopoverLayout({
    anchorX: args.popover.x,
    anchorY: args.popover.y,
    viewportWidth: args.viewport.width,
    viewportHeight: args.viewport.height,
    estimatedHeightPx,
  });
  return {
    ...layout,
    estimatedHeightPx,
  };
}

export function resolveStorylineSteeringPopoverLayout(args: {
  anchorX: number;
  anchorY: number;
  viewportWidth: number;
  viewportHeight: number;
  widthPx?: number;
  paddingPx?: number;
  minVisibleHeightPx?: number;
  estimatedHeightPx?: number;
}): {
  left: number;
  top: number;
} {
  const {
    anchorX,
    anchorY,
    viewportWidth,
    viewportHeight,
    widthPx = STORYLINE_STEERING_POPOVER_WIDTH_PX,
    paddingPx = STORYLINE_POPOVER_PADDING_PX,
    minVisibleHeightPx = STORYLINE_STEERING_POPOVER_MIN_VISIBLE_HEIGHT_PX,
    estimatedHeightPx = STORYLINE_STEERING_POPOVER_MIN_VISIBLE_HEIGHT_PX,
  } = args;
  const innerViewportHeight = Math.max(0, viewportHeight - paddingPx * 2);
  const effectiveEstimatedHeight = Math.min(
    Math.max(minVisibleHeightPx, estimatedHeightPx),
    innerViewportHeight
  );
  const maxTop = Math.max(
    paddingPx,
    viewportHeight - paddingPx - effectiveEstimatedHeight
  );
  const left = clamp(
    anchorX,
    paddingPx,
    Math.max(paddingPx, viewportWidth - widthPx - paddingPx)
  );
  const top = clamp(anchorY, paddingPx, maxTop);
  return {
    left,
    top,
  };
}

export default function StorylineSteeringPopover({
  popover,
  viewport,
  keywordOptions,
  isSubmitting,
  isConfirmDisabled = false,
  previewPlaceholder = 'Refine the user-visible steering request.',
  chipActiveClassName,
  chipIdleClassName,
  popoverRef,
  isDraggable = false,
  onKeywordToggle,
  onUserPromptChange,
  onIncludeBackgroundChange,
  onPopoverMouseDown,
  onCancel,
  onConfirm,
}: StorylineSteeringPopoverProps) {
  const [previewScroll, setPreviewScroll] = useState({ left: 0, top: 0 });
  const requiresKeywords = doesStorylineSteeringPopoverRequireKeywords(popover);
  const requiresBackground = doesStorylineSteeringPopoverRequireBackground(popover);
  const label = getSoftSteeringDisplayLabel(popover.kind);
  const targetSectionTitle = getTargetSectionTitle(popover.target);
  const targetLeadText = getTargetLeadText(popover.target);
  const targetBodyText = getTargetBodyText(popover.target, popover.kind);
  const previewSegments = buildStorylineSteeringPreviewSegments(popover);
  const previewHighlightClassName = getPreviewHighlightClassName(popover.kind);
  const previewScrollResetKey = [
    popover.kind,
    popover.target.kind,
    popover.target.summary_id,
    popover.target.atomic_id ?? '',
    popover.target.columns.join('|'),
  ].join('::');
  const layout = resolveStorylineSteeringPopoverPosition({
    popover,
    viewport,
  });
  const handlePopoverMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!isDraggable || event.button !== 0) {
      return;
    }
    const eventTarget = event.target;
    if (
      eventTarget instanceof Element
      && eventTarget.closest('button, input, textarea, select, label')
    ) {
      return;
    }
    onPopoverMouseDown?.(event, { left: layout.left, top: layout.top });
  };

  useEffect(() => {
    setPreviewScroll({ left: 0, top: 0 });
  }, [previewScrollResetKey]);

  return (
    <div
      ref={popoverRef}
      data-storyline-interactive="true"
      data-storyline-steering-popover="true"
      data-storyline-steering-popover-kind={popover.kind}
      data-storyline-steering-target-kind={popover.target.kind}
      data-storyline-keyword-popover={requiresKeywords ? 'true' : undefined}
      data-storyline-steering-draggable-surface={isDraggable ? 'true' : undefined}
      className={[
        'absolute z-50 w-[24rem] max-w-[calc(100%-1rem)] rounded-xl border border-slate-200 bg-white p-3 shadow-xl',
        isDraggable ? 'cursor-grab' : '',
      ].join(' ')}
      style={{
        left: layout.left,
        top: layout.top,
      }}
      onMouseDown={handlePopoverMouseDown}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div
            data-storyline-steering-popover-title="true"
          >
            <SteeringCardTitle kind={popover.kind} variant="popover" />
          </div>
        </div>
      </div>

      {requiresKeywords ? (
        <>
          <div className="mt-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Topic
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {keywordOptions.length > 0 ? keywordOptions.map((keyword) => {
                const isSelected = popover.selectedKeywords.includes(keyword);
                return (
                  <button
                    key={keyword}
                    type="button"
                    data-storyline-keyword-option={keyword}
                    data-storyline-keyword-selected={isSelected ? 'true' : undefined}
                    className={[
                      'rounded-full border px-3 py-1 text-xs font-medium transition',
                      isSelected ? chipActiveClassName : chipIdleClassName,
                    ].join(' ')}
                    onClick={() => onKeywordToggle(keyword)}
                  >
                    {keyword}
                  </button>
                );
              }) : (
                <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                  No stored keywords are available for this historical insight yet.
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="mt-3 space-y-3">
          <div>
            <div
              data-storyline-steering-section-title={targetSectionTitle.toLowerCase()}
              className="text-[11px] font-semibold uppercase tracking-wide text-slate-400"
            >
              {targetSectionTitle}
            </div>
            {popover.target.kind === 'column' ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {popover.target.columns.map((column) => (
                  <span
                    key={column}
                    data-storyline-steering-column-chip={column}
                    className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700"
                  >
                    {column}
                  </span>
                ))}
              </div>
            ) : (
              <div className="mt-2 space-y-1 text-sm text-slate-700">
                {targetLeadText ? (
                  <div data-storyline-steering-target-label="true" className="font-medium text-slate-900">
                    {targetLeadText}
                  </div>
                ) : null}
                {targetBodyText && targetBodyText !== targetLeadText ? (
                  <div data-storyline-steering-target-text="true" className="whitespace-pre-wrap">
                    {targetBodyText}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}
      <label className="mt-3 block">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Preview</div>
        <div className="mt-2 overflow-hidden rounded-lg border border-slate-200 bg-white transition focus-within:border-sky-300 focus-within:ring-2 focus-within:ring-sky-100">
          <div className="relative">
            <div
              aria-hidden="true"
              data-storyline-preview-highlight-layer="true"
              className="pointer-events-none absolute inset-0 overflow-hidden px-3 py-2 text-sm leading-5 text-slate-700"
            >
              <div
                className="min-h-full whitespace-pre-wrap break-words"
                style={{
                  transform: `translate(${-previewScroll.left}px, ${-previewScroll.top}px)`,
                }}
              >
                {previewSegments.length > 0 ? previewSegments.map((segment, index) => (
                  segment.highlighted ? (
                    <span
                      key={`${segment.text}-${index}`}
                      data-storyline-preview-highlight="true"
                      className={previewHighlightClassName}
                    >
                      {segment.text}
                    </span>
                  ) : (
                    <span key={`${segment.text}-${index}`}>{segment.text}</span>
                  )
                )) : <span>&nbsp;</span>}
              </div>
            </div>
            <textarea
              data-storyline-preview-input="true"
              rows={3}
              value={popover.userPromptDraft}
              onChange={(event) => onUserPromptChange(event.target.value)}
              onScroll={(event) => (
                setPreviewScroll({
                  left: event.currentTarget.scrollLeft,
                  top: event.currentTarget.scrollTop,
                })
              )}
              className="relative z-10 w-full resize-none bg-transparent px-3 py-2 text-sm leading-5 text-transparent caret-slate-700 outline-none placeholder:text-slate-400"
              placeholder={previewPlaceholder}
            />
          </div>
        </div>
      </label>
      {requiresBackground ? (
        <div
          className="mt-3 block"
          data-storyline-background-included={popover.includeBackground ? 'true' : 'false'}
        >
          <div className="flex items-center justify-between gap-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            <span>Background</span>
            <label
              className={[
                'inline-flex items-center gap-1.5 transition',
                popover.includeBackground ? 'text-slate-500' : 'text-slate-300',
              ].join(' ')}
            >
              <span data-storyline-background-include-label="true">Included</span>
              <input
                type="checkbox"
                data-storyline-background-include-toggle="true"
                checked={popover.includeBackground}
                aria-label="Include background in user prompt"
                className="h-3.5 w-3.5 accent-slate-900"
                onChange={(event) => onIncludeBackgroundChange(event.target.checked)}
              />
            </label>
          </div>
          <textarea
            data-storyline-background-readonly="true"
            data-storyline-background-readonly-style={popover.includeBackground ? 'included' : 'excluded'}
            rows={4}
            value={popover.backgroundText}
            readOnly
            className={[
              'mt-2 w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none transition',
              popover.includeBackground
                ? 'border-slate-200 bg-slate-50 text-slate-700'
                : 'border-slate-200 bg-slate-100 text-slate-400 opacity-80',
            ].join(' ')}
          />
        </div>
      ) : null}

      {popover.error ? (
        <div className="mt-3 text-xs text-rose-600">{popover.error}</div>
      ) : null}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          data-storyline-steering-confirm="true"
          disabled={isSubmitting || isConfirmDisabled}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onConfirm}
        >
          {isSubmitting ? 'Submitting...' : `Confirm ${label}`}
        </button>
      </div>
    </div>
  );
}
