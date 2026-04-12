import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import type { SteeringTargetSnapshot } from '@/types';

import StorylineSteeringPopover, {
  buildStorylineSteeringPreviewSegments,
  doesStorylineSteeringPopoverRequireKeywords,
  resolveStorylineSteeringPopoverLayout,
  resolveStorylineSteeringPopoverPosition,
  type StorylineSteeringPopoverState,
} from './storylineSteeringPopover.tsx';

function renderPopover(
  popover: StorylineSteeringPopoverState,
  keywordOptions: string[] = ['Revenue', 'Q4'],
  options: {
    isDraggable?: boolean;
    isConfirmDisabled?: boolean;
    previewPlaceholder?: string;
  } = {}
): string {
  return renderToStaticMarkup(
    <StorylineSteeringPopover
      popover={popover}
      viewport={{ width: 320, height: 220 }}
      keywordOptions={keywordOptions}
      isSubmitting={false}
      isConfirmDisabled={options.isConfirmDisabled}
      previewPlaceholder={options.previewPlaceholder}
      chipActiveClassName="chip-active"
      chipIdleClassName="chip-idle"
      onKeywordToggle={() => undefined}
      onUserPromptChange={() => undefined}
      onIncludeBackgroundChange={() => undefined}
      isDraggable={options.isDraggable}
      onCancel={() => undefined}
      onConfirm={() => undefined}
    />
  );
}

test('StorylineSteeringPopover disables confirm when keyword selection is required but empty', () => {
  const html = renderPopover(
    {
      kind: 'focus',
      target: makeSummaryTarget(),
      x: 120,
      y: 90,
      selectedKeywords: [],
      userPromptDraft: '',
      generatedPreviewBase: '',
      userPromptSuffix: '',
      backgroundText: 'Revenue grew sharply in Q4 for premium bundles.',
      includeBackground: true,
      error: null,
    },
    ['Revenue', 'Q4'],
    { isConfirmDisabled: true }
  );

  assert.match(html, /data-storyline-steering-confirm="true"[^>]*disabled=""/);
});

test('StorylineSteeringPopover supports a Chinese preview placeholder', () => {
  const placeholderText = '\u8bf7\u8865\u5145\u4f60\u5e0c\u671b\u7cfb\u7edf\u6267\u884c\u7684\u5f15\u5bfc\u8bed\u3002';
  const html = renderPopover(
    {
      kind: 'focus',
      target: makeSummaryTarget(),
      x: 120,
      y: 90,
      selectedKeywords: [],
      userPromptDraft: '',
      generatedPreviewBase: '',
      userPromptSuffix: '',
      backgroundText: 'Revenue grew sharply in Q4 for premium bundles.',
      includeBackground: true,
      error: null,
    },
    ['Revenue', 'Q4'],
    { previewPlaceholder: placeholderText }
  );

  assert.match(html, new RegExp(`placeholder="${placeholderText}"`));
});

function makeSummaryTarget(): SteeringTargetSnapshot {
  return {
    kind: 'summary',
    summary_id: 'summary_q4',
    summary_short_label: 'Holiday Revenue',
    summary_text: 'Revenue grew sharply in Q4 for premium bundles.',
    columns: ['Revenue', 'Quarter'],
  };
}

function makeAtomicTarget(): SteeringTargetSnapshot {
  return {
    kind: 'atomic',
    summary_id: 'summary_q4',
    summary_short_label: 'Holiday Revenue',
    summary_text: 'Revenue grew sharply in Q4 for premium bundles.',
    columns: ['Revenue', 'Week'],
    atomic_id: 'atomic_peak',
    atomic_text: 'Revenue spikes in holiday weeks.',
    insight_type: 'trend',
  };
}

function makeColumnTarget(): SteeringTargetSnapshot {
  return {
    kind: 'column',
    summary_id: '',
    summary_short_label: '',
    summary_text: '',
    columns: ['Revenue', 'Region'],
  };
}

test('StorylineSteeringPopover renders focus keyword chips with Preview and Background editors', () => {
  const html = renderPopover({
    kind: 'focus',
    target: makeSummaryTarget(),
    x: 120,
    y: 90,
    selectedKeywords: ['Revenue'],
    userPromptDraft: 'Focus on Revenue in Holiday Revenue.',
    generatedPreviewBase: 'Focus on Revenue in Holiday Revenue.',
    userPromptSuffix: '',
    backgroundText: 'Revenue grew sharply in Q4 for premium bundles.',
    includeBackground: true,
    error: null,
  });

  assert.match(html, /data-storyline-keyword-popover="true"/);
  assert.match(html, /data-storyline-steering-popover-title="true"/);
  assert.match(html, /data-steering-card-title-kind="focus"/);
  assert.match(html, /data-storyline-keyword-option="Revenue"/);
  assert.match(html, /data-storyline-preview-input="true"/);
  assert.match(html, /data-storyline-background-readonly="true"/);
  assert.match(html, /data-storyline-background-include-toggle="true"/);
  assert.match(html, /data-storyline-background-included="true"/);
  assert.match(html, /data-storyline-background-readonly-style="included"/);
  assert.match(html, /data-storyline-background-include-label="true"[^>]*>Included</);
  assert.match(html, />Preview</);
  assert.match(html, />Background</);
  assert.doesNotMatch(html, /data-storyline-background-input="true"/);
});

test('buildStorylineSteeringPreviewSegments highlights generated tokens but leaves appended user text plain', () => {
  const generatedPreviewBase =
    'In follow-up analysis, prioritize Revenue, Q4 for this summary.';
  const segments = buildStorylineSteeringPreviewSegments({
    kind: 'focus',
    target: makeSummaryTarget(),
    selectedKeywords: ['Revenue', 'Q4'],
    generatedPreviewBase,
    userPromptDraft: `${generatedPreviewBase}\nCompare Europe and North America next.`,
    userPromptSuffix: 'Compare Europe and North America next.',
  });

  assert.deepEqual(
    segments.filter((segment) => segment.highlighted).map((segment) => segment.text),
    ['Revenue', 'Q4']
  );
  assert.equal(
    segments.some(
      (segment) => segment.highlighted && segment.text.includes('Compare Europe and North America next.')
    ),
    false
  );
});

test('StorylineSteeringPopover renders an excluded visual state when background is unchecked', () => {
  const html = renderPopover({
    kind: 'focus',
    target: makeSummaryTarget(),
    x: 120,
    y: 90,
    selectedKeywords: ['Revenue'],
    userPromptDraft: 'Focus on Revenue in Holiday Revenue.',
    generatedPreviewBase: 'Focus on Revenue in Holiday Revenue.',
    userPromptSuffix: '',
    backgroundText: 'Revenue grew sharply in Q4 for premium bundles.',
    includeBackground: false,
    error: null,
  });

  assert.match(html, /data-storyline-background-included="false"/);
  assert.match(html, /data-storyline-background-readonly-style="excluded"/);
  assert.match(html, /opacity-80/);
  assert.doesNotMatch(html, /line-through/);
});

test('StorylineSteeringPopover renders column ignore with a Preview editor and no keyword inputs', () => {
  const html = renderPopover({
    kind: 'ignore',
    target: makeColumnTarget(),
    x: 260,
    y: 180,
    selectedKeywords: [],
    userPromptDraft: 'Ignore Revenue, Region.',
    generatedPreviewBase: 'Ignore Revenue, Region.',
    userPromptSuffix: '',
    backgroundText: '',
    includeBackground: true,
    error: null,
  });

  assert.equal(
    doesStorylineSteeringPopoverRequireKeywords({
      kind: 'ignore',
      target: makeColumnTarget(),
    }),
    false
  );
  assert.match(html, /data-storyline-steering-target-kind="column"/);
  assert.match(html, /data-storyline-steering-popover-title="true"/);
  assert.match(html, /data-steering-card-title-kind="ignore"/);
  assert.match(html, /data-storyline-steering-section-title="column"[^>]*>Column</);
  assert.match(html, /data-storyline-steering-column-chip="Revenue"/);
  assert.match(html, /data-storyline-steering-column-chip="Region"/);
  assert.match(html, /data-storyline-preview-input="true"/);
  assert.doesNotMatch(html, /data-storyline-background-input="true"/);
  assert.doesNotMatch(html, /data-storyline-keyword-other-input="true"/);
  assert.doesNotMatch(html, />Anchor Column</);
  assert.doesNotMatch(html, /Stop pursuing future analysis centered on this column group/);
});

test('StorylineSteeringPopover renders preview highlights for generated column names', () => {
  const html = renderPopover({
    kind: 'ignore',
    target: makeColumnTarget(),
    x: 260,
    y: 180,
    selectedKeywords: [],
    userPromptDraft: 'Deprioritize future analysis on the dataset columns Revenue, Region.',
    generatedPreviewBase: 'Deprioritize future analysis on the dataset columns Revenue, Region.',
    userPromptSuffix: '',
    backgroundText: '',
    includeBackground: true,
    error: null,
  });

  assert.match(html, /data-storyline-preview-highlight-layer="true"/);
  assert.match(html, /data-storyline-preview-highlight="true"[^>]*class="font-semibold text-rose-700"[^>]*>Revenue</);
  assert.match(html, /data-storyline-preview-highlight="true"[^>]*class="font-semibold text-rose-700"[^>]*>Region</);
  assert.match(html, /data-storyline-preview-input="true"[^>]*class="[^"]*text-transparent[^"]*caret-slate-700/);
});

test('StorylineSteeringPopover renders elaborate preview with target label and atomic text', () => {
  const html = renderPopover(
    {
      kind: 'elaborate',
      target: makeAtomicTarget(),
      x: 140,
      y: 120,
      selectedKeywords: [],
      userPromptDraft: 'Explain Holiday Revenue in more detail.',
      generatedPreviewBase: 'Explain Holiday Revenue in more detail.',
      userPromptSuffix: '',
      backgroundText: '',
      includeBackground: true,
      error: null,
    },
    []
  );

  assert.equal(
    doesStorylineSteeringPopoverRequireKeywords({
      kind: 'elaborate',
      target: makeAtomicTarget(),
    }),
    false
  );
  assert.match(html, /data-storyline-steering-popover-title="true"/);
  assert.match(html, /data-steering-card-title-kind="elaborate"/);
  assert.match(html, /data-storyline-steering-section-title="target"[^>]*>Target</);
  assert.match(html, /data-storyline-steering-target-label="true"[^>]*>Holiday Revenue</);
  assert.match(html, /data-storyline-steering-target-text="true"[^>]*>Revenue spikes in holiday weeks\.</);
  assert.match(html, /data-storyline-preview-input="true"/);
  assert.doesNotMatch(html, /data-storyline-background-input="true"/);
  assert.match(html, /Revenue spikes in holiday weeks\./);
  assert.doesNotMatch(html, /Keep follow-up analysis tightly centered/);
  assert.doesNotMatch(html, /Related columns:/);
  assert.doesNotMatch(html, /data-storyline-keyword-option=/);
});

test('StorylineSteeringPopover keeps summary elaborate confirmation compact by omitting the full summary body', () => {
  const html = renderPopover(
    {
      kind: 'elaborate',
      target: makeSummaryTarget(),
      x: 140,
      y: 120,
      selectedKeywords: [],
      userPromptDraft: 'Explain Holiday Revenue in more detail.',
      generatedPreviewBase: 'Explain Holiday Revenue in more detail.',
      userPromptSuffix: '',
      backgroundText: '',
      includeBackground: true,
      error: null,
    },
    []
  );

  assert.match(html, /data-storyline-steering-section-title="target"[^>]*>Target</);
  assert.match(html, /data-storyline-steering-target-label="true"[^>]*>Holiday Revenue</);
  assert.doesNotMatch(html, /data-storyline-steering-target-text="true"/);
  assert.doesNotMatch(html, /Revenue grew sharply in Q4 for premium bundles\./);
});

test('resolveStorylineSteeringPopoverLayout prefers shifting the popover upward on low heights', () => {
  const layout = resolveStorylineSteeringPopoverLayout({
    anchorX: 260,
    anchorY: 190,
    viewportWidth: 320,
    viewportHeight: 220,
    estimatedHeightPx: 192,
  });

  assert.deepEqual(layout, {
    left: 8,
    top: 20,
  });
});

test('StorylineSteeringPopover exposes a draggable card surface without a drag handle', () => {
  const html = renderPopover(
    {
      kind: 'focus',
      target: makeColumnTarget(),
      x: 120,
      y: 90,
      selectedKeywords: [],
      userPromptDraft: 'Focus on Revenue, Region.',
      generatedPreviewBase: 'Focus on Revenue, Region.',
      userPromptSuffix: '',
      backgroundText: '',
      includeBackground: true,
      error: null,
    },
    [],
    { isDraggable: true }
  );

  assert.match(html, /data-storyline-steering-draggable-surface="true"/);
  assert.doesNotMatch(html, /data-storyline-steering-drag-handle="true"/);
  assert.doesNotMatch(html, /aria-label="Drag steering popover"/);
});

test('resolveStorylineSteeringPopoverPosition clamps dragged popovers back into the viewport', () => {
  const layout = resolveStorylineSteeringPopoverPosition({
    popover: {
      kind: 'ignore',
      target: makeColumnTarget(),
      x: 999,
      y: -50,
      userPromptDraft: 'Ignore Revenue, Region.',
      backgroundText: '',
      error: null,
    },
    viewport: { width: 320, height: 220 },
  });

  assert.equal(layout.left, 8);
  assert.equal(layout.top, 8);
  assert.ok(layout.estimatedHeightPx >= 192);
});
