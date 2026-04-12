import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import StorylineSoftSteeringIcon from './storylineSoftSteeringIcon.tsx';

test('StorylineSoftSteeringIcon keeps summary markers flush with the target border corner', () => {
  const html = renderToStaticMarkup(
    <svg>
      <StorylineSoftSteeringIcon
        kind="focus"
        anchorX={32}
        anchorY={18}
        scope="summary"
      />
    </svg>
  );

  assert.match(html, /data-storyline-soft-steering-icon="focus"/);
  assert.match(html, /data-storyline-soft-steering-scope="summary"/);
  assert.match(html, /<rect[^>]*x="18"[^>]*y="4"[^>]*width="14"[^>]*height="14"/);
  assert.doesNotMatch(html, /Focus|Ignore/);
});

test('StorylineSoftSteeringIcon places column markers on the indicator corner area without the strict flush rule', () => {
  const html = renderToStaticMarkup(
    <svg>
      <StorylineSoftSteeringIcon
        kind="ignore"
        anchorX={40}
        anchorY={20}
        scope="column"
      />
    </svg>
  );

  assert.match(html, /data-storyline-soft-steering-icon="ignore"/);
  assert.match(html, /data-storyline-soft-steering-scope="column"/);
  assert.match(html, /<rect[^>]*x="28"[^>]*y="10"[^>]*width="14"[^>]*height="14"/);
  assert.doesNotMatch(html, /<rect[^>]*x="26"[^>]*y="6"[^>]*width="14"[^>]*height="14"/);
  assert.match(html, /stroke="#be123c"/);
  assert.doesNotMatch(html, /Ignore/);
});

test('StorylineSoftSteeringIcon renders elaborate styling with the dedicated icon palette', () => {
  const html = renderToStaticMarkup(
    <svg>
      <StorylineSoftSteeringIcon
        kind="elaborate"
        anchorX={32}
        anchorY={18}
        scope="atomic"
      />
    </svg>
  );

  assert.match(html, /data-storyline-soft-steering-icon="elaborate"/);
  assert.match(html, /data-storyline-soft-steering-scope="atomic"/);
  assert.match(html, /stroke="#1d4ed8"/);
  assert.doesNotMatch(html, /Elaborate/);
});
