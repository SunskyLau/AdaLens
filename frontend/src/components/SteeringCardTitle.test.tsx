import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import SteeringCardTitle from './SteeringCardTitle.tsx';

test('SteeringCardTitle renders create with the shared popover title styling', () => {
  const html = renderToStaticMarkup(
    <SteeringCardTitle kind="create" variant="popover" />
  );

  assert.match(html, /data-steering-card-title-kind="create"/);
  assert.match(
    html,
    /data-steering-card-title-icon="create"[^>]*border-emerald-200 bg-emerald-100 text-emerald-700/
  );
  assert.match(html, /uppercase tracking-\[0\.18em\]/);
  assert.match(html, />Create</);
});
