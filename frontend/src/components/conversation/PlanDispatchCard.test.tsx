import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import PlanDispatchCard, { isPlanModifySubmitKey } from './PlanDispatchCard.tsx';

const basePlan = {
  plan_id: 'plan_123',
  text: 'Investigate the late-stage regional outliers.',
  short_label: 'Regional outlier scan',
  status: 'paused' as const,
  control_state: 'none' as const,
};

test('isPlanModifySubmitKey accepts plain Enter only', () => {
  assert.equal(
    isPlanModifySubmitKey({
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
    }),
    true
  );
  assert.equal(
    isPlanModifySubmitKey({
      key: 'Enter',
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
    }),
    false
  );
  assert.equal(
    isPlanModifySubmitKey({
      key: 'Enter',
      shiftKey: false,
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      isComposing: false,
    }),
    false
  );
});

test('PlanDispatchCard keeps modify visible but disabled for non-editable storyline statuses', () => {
  const html = renderToStaticMarkup(
    <PlanDispatchCard
      planId="plan_done"
      plan={{ ...basePlan, status: 'completed' }}
      variant="storyline"
      onSelect={() => undefined}
      onControl={() => undefined}
      onModifyStart={() => undefined}
    />
  );

  assert.match(html, /aria-label="Modify"[^>]*disabled/);
  assert.doesNotMatch(html, /aria-label="Resume"/);
  assert.doesNotMatch(html, /aria-label="Terminate"/);
});

test('PlanDispatchCard keeps non-editing storyline text clipped inside the card body', () => {
  const html = renderToStaticMarkup(
    <PlanDispatchCard
      planId="plan_long"
      plan={{
        ...basePlan,
        short_label: '',
        text: 'Identify which specific players are taking the shots for each team during their peak efficiency windows.',
      }}
      variant="storyline"
      onSelect={() => undefined}
      onControl={() => undefined}
      onModifyStart={() => undefined}
    />
  );

  assert.match(html, /class="mt-2 block w-full min-h-0 overflow-hidden rounded-md text-left"/);
  assert.match(html, /class="overflow-hidden break-words text-sm leading-5 text-slate-700"/);
});

test('PlanDispatchCard renders the inline modify editor with a confirm button', () => {
  const html = renderToStaticMarkup(
    <PlanDispatchCard
      planId="plan_123"
      plan={basePlan}
      variant="storyline"
      isEditing
      modifyDraft={'Line one.\nLine two.'}
      onSelect={() => undefined}
      onControl={() => undefined}
      onModifyStart={() => undefined}
      onModifyDraftChange={() => undefined}
      onModifyCancel={() => undefined}
      onModifySubmit={() => undefined}
      style={{ height: '100%' }}
    />
  );

  assert.match(html, /data-plan-dispatch-card-editing="true"/);
  assert.match(html, /aria-label="Confirm"/);
  assert.match(html, /aria-label="Edit plan text"/);
  assert.match(html, /aria-label="Resume"[^>]*disabled/);
  assert.match(html, /aria-label="Terminate"[^>]*disabled/);
});
