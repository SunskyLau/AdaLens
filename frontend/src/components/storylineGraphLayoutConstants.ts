import type { StorylineAdaptiveProfile } from './storylineGraphLayout';

export const STORYLINE_GLYPH_MIN_DIAMETER_PX = 5;
export const STORYLINE_GLYPH_MAX_DIAMETER_PX = 96;
export const STORYLINE_SLOT_SIDE_CLEARANCE_PX = 2;
export const GLYPH_HIT_PADDING_PX = 12;
export const GLYPH_MIN_HIT_DIAMETER_PX = 26;
export const GLYPH_SHORT_SIDE_MIN_PX = 320;
export const GLYPH_SHORT_SIDE_MAX_PX = 1400;
export const GLYPH_MIN_DIAMETER_RATIO = 0.014;
export const GLYPH_MAX_DIAMETER_RATIO = 0.075;
export const GLYPH_MIN_CAP_PX = 20;
export const GLYPH_MAX_FLOOR_PX = 28;
export const GLYPH_MIN_MAX_GAP_PX = 18;
export const ROUTEBOX_GLYPH_PADDING_PX = 4;
export const NODE_PORT_GAP_PX = 10;
export const NODE_PORT_PADDING_PX = 16;
export const NODE_X_BASE_GAP_PX = 64;
export const NODE_X_MIN_GAP_PX = 24;
export const PLOT_HORIZONTAL_PADDING_PX = 86;
export const TRACK_ENDPOINT_SEGMENT_PX = 52;
export const SLOT_WIDTH_SCALE = 1.2;
export const INTERSPACE_WIDTH_SCALE = 1;
export const ROUTEBOX_RADIUS_MIN_PX = 2.4;
export const ROUTEBOX_RADIUS_RATIO = 0.096;
export const ROUTEBOX_SAFE_MARGIN_PX = 0.5;
export const UNINVOLVED_SLOT_ROUTEBOX_CLEARANCE_MIN_PX = 1.5;
export const D1_HARD_FLOOR_PX = 8;
export const NO_COLUMN_LABEL = 'No column';

export const ZOOM_MIN = 0.01;
export const ZOOM_MAX = 7.0;
export const ZOOM_WHEEL_SPEED = 0.0012;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createStorylineAdaptiveProfile(xZoomRatioInput = 1): StorylineAdaptiveProfile {
  const xZoomRatio = clamp(xZoomRatioInput, ZOOM_MIN, ZOOM_MAX);
  const adaptiveFloor = Math.pow(ZOOM_MIN, 0.35);
  const slotScaleFloor = Math.pow(ZOOM_MIN, 0.55);
  const interspaceScaleFloor = Math.pow(ZOOM_MIN, 0.5);
  const trackScaleFloor = Math.pow(ZOOM_MIN, 0.3);
  const d1ScaleFloor = Math.pow(ZOOM_MIN, 0.35);
  const d2ScaleFloor = Math.pow(ZOOM_MIN, 0.3);
  const tickScaleFloor = Math.pow(ZOOM_MIN, 0.28);
  const labelScaleFloor = Math.pow(ZOOM_MIN, 0.25);
  const adaptive = clamp(Math.pow(xZoomRatio, 0.35), adaptiveFloor, 1.45);
  return {
    xZoomRatio,
    adaptive,
    glyphScale: adaptive,
    routeBoxScale: adaptive,
    slotWidthScale: clamp(Math.pow(xZoomRatio, 0.55), slotScaleFloor, 1.9),
    interspaceWidthScale: clamp(Math.pow(xZoomRatio, 0.5), interspaceScaleFloor, 1.8),
    trackStrokeScale: clamp(Math.pow(xZoomRatio, 0.3), trackScaleFloor, 1.35),
    d1Scale: clamp(Math.pow(xZoomRatio, 0.35), d1ScaleFloor, 1.35),
    d2Scale: clamp(Math.pow(xZoomRatio, 0.3), d2ScaleFloor, 1.28),
    tickScale: clamp(Math.pow(xZoomRatio, 0.28), tickScaleFloor, 1.3),
    labelScale: clamp(Math.pow(xZoomRatio, 0.25), labelScaleFloor, 1.25),
  };
}

export function computeGlyphDiameterRange(viewportWidthPx: number, viewportHeightPx: number): {
  minDiameter: number;
  maxDiameter: number;
} {
  const safeWidth = Math.max(1, viewportWidthPx);
  const safeHeight = Math.max(1, viewportHeightPx);
  const shortSide = clamp(
    Math.min(safeWidth, safeHeight),
    GLYPH_SHORT_SIDE_MIN_PX,
    GLYPH_SHORT_SIDE_MAX_PX
  );
  const minDiameter = clamp(
    shortSide * GLYPH_MIN_DIAMETER_RATIO,
    STORYLINE_GLYPH_MIN_DIAMETER_PX,
    GLYPH_MIN_CAP_PX
  );
  const maxDiameterByRatio = clamp(
    shortSide * GLYPH_MAX_DIAMETER_RATIO,
    GLYPH_MAX_FLOOR_PX,
    STORYLINE_GLYPH_MAX_DIAMETER_PX
  );
  return {
    minDiameter,
    maxDiameter: Math.max(maxDiameterByRatio, minDiameter + GLYPH_MIN_MAX_GAP_PX),
  };
}

export function computeRouteBoxRadius(width: number, height: number): number {
  const minDim = Math.max(0, Math.min(width, height));
  const target = Math.max(ROUTEBOX_RADIUS_MIN_PX, minDim * ROUTEBOX_RADIUS_RATIO);
  const maxRoundedCorner = Math.max(0, minDim / 2 - ROUTEBOX_SAFE_MARGIN_PX);
  return Math.min(target, maxRoundedCorner);
}
