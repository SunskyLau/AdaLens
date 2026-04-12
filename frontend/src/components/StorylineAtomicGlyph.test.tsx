import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import StorylineAtomicGlyph, { InsightTypeGlyphMark } from './StorylineAtomicGlyph.tsx';

test('StorylineAtomicGlyph renders icon-only steering marker on the route-box corner', () => {
  const html = renderToStaticMarkup(
    <svg>
      <StorylineAtomicGlyph
        node={{
          id: 's1::a1',
          summaryId: 's1',
          atomicId: 'a1',
          x: 60,
          y: 40,
          width: 24,
          height: 20,
          glyphDiameter: 10,
          hitDiameter: 16,
          columns: ['Revenue'],
          portOffsetByColumn: { Revenue: 0 },
          insightType: 'trend',
          sizeScale: 1,
          sizeRatio: 0.5,
          timestampMs: 1,
        }}
        isSelected={false}
        steeringKind="ignore"
        onSelect={() => undefined}
      />
    </svg>
  );

  assert.match(html, /data-storyline-soft-steering-icon="ignore"/);
  assert.match(html, /data-storyline-soft-steering-scope="atomic"/);
  assert.doesNotMatch(html, /Ignore/);
});

test('StorylineAtomicGlyph exposes the pen-hover state without changing the summary boundary contract', () => {
  const html = renderToStaticMarkup(
    <svg>
      <StorylineAtomicGlyph
        node={{
          id: 's1::a1',
          summaryId: 's1',
          atomicId: 'a1',
          x: 60,
          y: 40,
          width: 24,
          height: 20,
          glyphDiameter: 10,
          hitDiameter: 16,
          columns: ['Revenue'],
          portOffsetByColumn: { Revenue: 0 },
          insightType: 'trend',
          sizeScale: 1,
          sizeRatio: 0.5,
          timestampMs: 1,
        }}
        isSelected={false}
        isPenHovered
        onSelect={() => undefined}
      />
    </svg>
  );

  assert.match(html, /data-storyline-glyph-pen-hovered="true"/);
});

test('InsightTypeGlyphMark renders rank labels above each step using the podium color', () => {
  const html = renderToStaticMarkup(
    <svg>
      <InsightTypeGlyphMark insightType="rank" size={14} color="#2563eb" />
    </svg>
  );

  assert.match(html, />3<\/text>/);
  assert.match(html, />2<\/text>/);
  assert.match(html, />1<\/text>/);
  assert.doesNotMatch(html, /fill="#ffffff"/);

  const podiumPathMatch = html.match(/<path d="([^"]+)" fill="#2563eb"/);
  assert.ok(podiumPathMatch, 'rank podium path should exist');
  const coords = (podiumPathMatch?.[1] ?? '')
    .match(/-?[0-9]*\.?[0-9]+/g)
    ?.map((token) => Number.parseFloat(token)) ?? [];
  const points: Array<{ x: number; y: number }> = [];
  for (let index = 0; index + 1 < coords.length; index += 2) {
    points.push({ x: coords[index], y: coords[index + 1] });
  }
  assert.ok(points.length >= 6, 'rank podium path should expose step-top y coordinates');
  const stepTopYs = [points[1].y, points[3].y, points[5].y];
  const labelMatches = [
    ...html.matchAll(/<text[^>]*x="(-?[0-9.]+)"[^>]*y="(-?[0-9.]+)"[^>]*fill="([^"]+)"[^>]*>([123])<\/text>/g),
  ];
  assert.equal(labelMatches.length, 3);

  labelMatches.forEach((match, index) => {
    const labelY = Number.parseFloat(match[2] ?? '0');
    const fill = match[3] ?? '';
    assert.equal(fill, '#2563eb');
    assert.ok(
      labelY < stepTopYs[index] - 0.01,
      `rank label ${index + 1} should render above its step top`
    );
  });
});

test('InsightTypeGlyphMark constrains rank podium and labels when maxHeight/maxWidth are provided', () => {
  const maxHeight = 6.2;
  const maxWidth = 4.4;
  const html = renderToStaticMarkup(
    <svg>
      <InsightTypeGlyphMark
        insightType="rank"
        size={14}
        color="#2563eb"
        maxHeight={maxHeight}
        maxWidth={maxWidth}
      />
    </svg>
  );

  const podiumPathMatch = html.match(/<path d="([^"]+)" fill="#2563eb"/);
  assert.ok(podiumPathMatch, 'rank podium path should exist');

  const coords = (podiumPathMatch?.[1] ?? '')
    .match(/-?[0-9]*\.?[0-9]+/g)
    ?.map((token) => Number.parseFloat(token)) ?? [];
  const points: Array<{ x: number; y: number }> = [];
  for (let index = 0; index + 1 < coords.length; index += 2) {
    points.push({ x: coords[index], y: coords[index + 1] });
  }
  assert.ok(points.length > 0, 'rank podium path should have points');

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const textMatches = [
    ...html.matchAll(/<text[^>]*y="(-?[0-9.]+)"[^>]*font-size="([0-9.]+)"/g),
  ];
  assert.equal(textMatches.length, 3);
  const minTextTopY = Math.min(
    ...textMatches.map((match) => Number.parseFloat(match[1] ?? '0') - Number.parseFloat(match[2] ?? '0') / 2)
  );
  const maxTextBottomY = Math.max(
    ...textMatches.map((match) => Number.parseFloat(match[1] ?? '0') + Number.parseFloat(match[2] ?? '0') / 2)
  );
  const totalWidth = maxX - minX;
  const totalHeight = Math.max(maxY, maxTextBottomY) - Math.min(minY, minTextTopY);

  assert.ok(totalWidth <= maxWidth + 0.05);
  assert.ok(totalHeight <= maxHeight + 0.05);
});

test('InsightTypeGlyphMark renders updated extreme, value, and cluster glyph primitives', () => {
  const extremeHtml = renderToStaticMarkup(
    <svg>
      <InsightTypeGlyphMark insightType="extreme" size={14} color="#ef4444" />
    </svg>
  );
  assert.match(extremeHtml, /<polyline/);
  assert.match(extremeHtml, /<circle cx="0" cy="-/);
  assert.doesNotMatch(extremeHtml, /<polygon/);

  const valueHtml = renderToStaticMarkup(
    <svg>
      <InsightTypeGlyphMark insightType="value" size={14} color="#f59e0b" />
    </svg>
  );
  const valueRectMatches = valueHtml.match(/<rect /g) ?? [];
  assert.equal(valueRectMatches.length, 3);

  const clusterHtml = renderToStaticMarkup(
    <svg>
      <InsightTypeGlyphMark insightType="cluster" size={14} color="#14b8a6" />
    </svg>
  );
  const clusterCircleMatches = clusterHtml.match(/<circle /g) ?? [];
  assert.equal(clusterCircleMatches.length, 10);
});

test('InsightTypeGlyphMark constrains extreme glyph total bounds when maxHeight/maxWidth are provided', () => {
  const maxHeight = 5.6;
  const maxWidth = 4.8;
  const html = renderToStaticMarkup(
    <svg>
      <InsightTypeGlyphMark
        insightType="extreme"
        size={14}
        color="#ef4444"
        maxHeight={maxHeight}
        maxWidth={maxWidth}
      />
    </svg>
  );

  const polylineMatch = html.match(/<polyline[^>]*points="([^"]+)"/);
  const polylineStrokeWidthMatch = html.match(/<polyline[^>]*stroke-width="([0-9.]+)"/);
  const apexDotMatch = html.match(/<circle cx="0" cy="(-?[0-9.]+)" r="([0-9.]+)" fill="#ef4444"/);
  assert.ok(polylineMatch, 'polyline should exist for extreme glyph');
  assert.ok(polylineStrokeWidthMatch, 'polyline stroke width should exist for extreme glyph');
  assert.ok(apexDotMatch, 'apex dot should exist for extreme glyph');

  const polylinePoints = (polylineMatch?.[1] ?? '')
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(',');
      return {
        x: Number.parseFloat(x),
        y: Number.parseFloat(y),
      };
    });
  const polylineStrokeWidth = Number.parseFloat(polylineStrokeWidthMatch?.[1] ?? '0');
  const halfStroke = polylineStrokeWidth / 2;
  const apexCy = Number.parseFloat(apexDotMatch?.[1] ?? '0');
  const apexR = Number.parseFloat(apexDotMatch?.[2] ?? '0');
  const minX = Math.min(...polylinePoints.map((point) => point.x - halfStroke), -apexR);
  const maxX = Math.max(...polylinePoints.map((point) => point.x + halfStroke), apexR);
  const minY = Math.min(...polylinePoints.map((point) => point.y - halfStroke), apexCy - apexR);
  const maxY = Math.max(...polylinePoints.map((point) => point.y + halfStroke), apexCy + apexR);
  const totalWidth = maxX - minX;
  const totalHeight = maxY - minY;

  assert.ok(totalWidth <= maxWidth + 0.05);
  assert.ok(totalHeight <= maxHeight + 0.05);
});

test('InsightTypeGlyphMark renders data-quality glyph via the dedicated svg slot', () => {
  const html = renderToStaticMarkup(
    <svg>
      <InsightTypeGlyphMark insightType="data_quality" size={14} color="#0ea5e9" />
    </svg>
  );

  assert.match(html, /data-storyline-data-quality-glyph-svg="true"/);
  assert.match(html, /color="#0ea5e9"/);
  assert.match(html, /<path /);
});

test('InsightTypeGlyphMark constrains data-quality svg bounds when maxHeight\\/maxWidth are provided', () => {
  const maxHeight = 5.5;
  const maxWidth = 4.1;
  const html = renderToStaticMarkup(
    <svg>
      <InsightTypeGlyphMark
        insightType="data_quality"
        size={14}
        color="#0ea5e9"
        maxHeight={maxHeight}
        maxWidth={maxWidth}
      />
    </svg>
  );

  const sizeMatch = html.match(
    /data-storyline-data-quality-glyph-svg="true"[^>]*width="([0-9.]+)"[^>]*height="([0-9.]+)"/
  );
  assert.ok(sizeMatch, 'data-quality svg wrapper should expose width/height');
  const width = Number.parseFloat(sizeMatch?.[1] ?? '0');
  const height = Number.parseFloat(sizeMatch?.[2] ?? '0');
  assert.ok(width <= maxWidth + 0.05);
  assert.ok(height <= maxHeight + 0.05);
});
