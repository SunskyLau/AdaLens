/**
 * Frontend configuration (shared constants).
 *
 * Keep this small: only parameters that are reused in multiple places or
 * commonly tuned should live here.
 */

export const API_BASE = '/api';

// Run Gateway server port (backend/run_gateway_flask.py).
export const RUN_GATEWAY_PORT = 3001;

// Backend/frontend run-data contract version
export const DATA_CONTRACT_VERSION = 'v1.13';

// Data View (CSV preview)
export const DATA_VIEW_PREVIEW_ROWS = 30;
export const DATA_VIEW_MAX_ROWS = 200;
export const DATA_VIEW_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const DATA_VIEW_MAX_CELL_CHARS = 120;
export const DATA_VIEW_CELL_WIDTH_PX = 80;
export const DATA_TABLE_MODAL_MIN_WIDTH_PX = 560;
export const DATA_TABLE_MODAL_ROW_INDEX_WIDTH_PX = 40;
export const DATA_TABLE_MODAL_MAX_WIDTH_VW = 95;

// Exploration Tree
export const EXPLORATION_TREE_CARD_HEIGHT_PX = 74;

// Workspace panel section headers
// Keep all panel titles aligned to the shared workspace header height.
export const WORKSPACE_PANEL_HEADER_HEIGHT_PX = 32;

// ============================================================================
// Exploration Graph (radial node-link)
// ============================================================================

// Node sizing (px)
export const EXPLORATION_GRAPH_ROOT_RADIUS_PX = 38;
export const EXPLORATION_GRAPH_NODE_OUTER_RADIUS_PX = 50;
export const EXPLORATION_GRAPH_NODE_INNER_RADIUS_PX = 36;
export const EXPLORATION_GRAPH_NODE_HIT_RADIUS_PX = 60;
export const EXPLORATION_GRAPH_NODE_COUNT_FONT_SIZE_PX = 14;

// Card node dimensions (replaces circular donut in ego-centric view)
export const EXPLORATION_GRAPH_CARD_WIDTH_PX = 160;
export const EXPLORATION_GRAPH_CARD_HEIGHT_PX = 64;

// Layout tuning (px)
export const EXPLORATION_GRAPH_BASE_PLAN_RADIUS_PX = 210;
export const EXPLORATION_GRAPH_DEPTH_RING_GAP_PX = 298;
export const EXPLORATION_GRAPH_SUMMARY_RING_OFFSET_PX = 88;
export const EXPLORATION_GRAPH_MIN_PLAN_ARC_SPACING_PX = 68;
export const EXPLORATION_GRAPH_MIN_SUMMARY_ARC_SPACING_PX = 120;

// Root label
export const EXPLORATION_GRAPH_ROOT_LABEL_MAX_CHARS = 28;
export const EXPLORATION_GRAPH_ROOT_LABEL_OFFSET_Y_PX = 60;

// Pan/Zoom tuning
export const EXPLORATION_GRAPH_MIN_SCALE = 0.01;
export const EXPLORATION_GRAPH_MAX_SCALE = 7;
export const EXPLORATION_GRAPH_ZOOM_SENSITIVITY = 0.0012;
export const EXPLORATION_GRAPH_OVERVIEW_FIT_PADDING_PX = 24;

// Ring visibility
export const EXPLORATION_GRAPH_RING_STROKE_HEX = '#bfc8d4';
export const EXPLORATION_GRAPH_RING_STROKE_WIDTH_PX = 1.2;
export const EXPLORATION_GRAPH_RING_OPACITY = 0.24;
export const EXPLORATION_GRAPH_RING_OPACITY_FOCUSED = 0.21;

// ============================================================================
// Narrative Flow Graph (left-to-right node-link)
// ============================================================================

// LTR layout tuning (px)
export const EXPLORATION_GRAPH_LTR_LEFT_PADDING_PX = 140;
export const EXPLORATION_GRAPH_LTR_TOP_PADDING_PX = 110;
export const EXPLORATION_GRAPH_LTR_SUMMARY_NODE_OFFSET_X_PX = 48;
export const EXPLORATION_GRAPH_EDGE_CURVE_LENGTH_PX = 24;
export const EXPLORATION_GRAPH_EDGE_PORT_GAP_PX = 12;
export const EXPLORATION_GRAPH_EDGE_MIN_TRUNK_PX = 32;
export const EXPLORATION_GRAPH_LAYOUT_DEPTH_MIN_GAP_PX = 32;
export const EXPLORATION_GRAPH_LAYOUT_ROW_GAP_PX = 26;
export const EXPLORATION_GRAPH_LAYOUT_VERTICAL_PADDING_PX = 14;
export const EXPLORATION_GRAPH_LAYOUT_NODE_CLEARANCE_PX = 16;
export const EXPLORATION_GRAPH_LAYOUT_LABEL_CLEARANCE_PX = 10;

// Narrative root label
export const EXPLORATION_GRAPH_ROOT_LABEL_OFFSET_X_PX = 68;
export const EXPLORATION_GRAPH_NARRATIVE_ROOT_LABEL_OFFSET_Y_PX = 4;

// LTR-specific root label offset (below root node)
export const EXPLORATION_GRAPH_LTR_ROOT_LABEL_OFFSET_Y_PX = 50;

// Plan line label
export const EXPLORATION_GRAPH_PLAN_LABEL_FONT_SIZE_PX = 10;
export const EXPLORATION_GRAPH_PLAN_LABEL_LINE_HEIGHT_PX = 14;
export const EXPLORATION_GRAPH_PLAN_LABEL_MAX_LINE_WIDTH_PX = 360;
export const EXPLORATION_GRAPH_PLAN_LABEL_CHAR_WIDTH_PX = 5.8;
export const EXPLORATION_GRAPH_PLAN_LABEL_EDGE_GAP_PX = 8;
export const EXPLORATION_GRAPH_NARRATIVE_FULL_LABEL_SCALE = 0.9;
export const EXPLORATION_GRAPH_NARRATIVE_COMPACT_LABEL_SCALE = 0.6;

// Structure graph view (ego-centric full view + narrative inset)
export const STRUCTURE_GRAPH_PANE_LABEL_TOP_PX = 8;
export const STRUCTURE_GRAPH_PANE_LABEL_LEFT_PX = 10;
export const STRUCTURE_GRAPH_NARRATIVE_INSET_WIDTH_PX = 480;
export const STRUCTURE_GRAPH_NARRATIVE_INSET_HEIGHT_PX = 280;
export const STRUCTURE_GRAPH_NARRATIVE_INSET_MIN_WIDTH_PX = 360;
export const STRUCTURE_GRAPH_NARRATIVE_INSET_MIN_HEIGHT_PX = 220;
export const STRUCTURE_GRAPH_NARRATIVE_INSET_RIGHT_PX = 12;
export const STRUCTURE_GRAPH_NARRATIVE_INSET_BOTTOM_PX = 12;

// ============================================================================
// Storyline Graph
// ============================================================================

export const STORYLINE_AXIS_HEIGHT_PX = 72;
export const STORYLINE_TOP_PADDING_PX = 26;
export const STORYLINE_BOTTOM_PADDING_PX = 48;
export const STORYLINE_LEFT_GUTTER_PX = 170;
export const STORYLINE_RIGHT_PADDING_PX = 44;
export const STORYLINE_LANE_SPACING_PX = 62;
export const STORYLINE_STEP_WIDTH_PX = 188;
export const STORYLINE_NODE_WIDTH_PX = 164;
export const STORYLINE_NODE_BASE_HEIGHT_PX = 74;
export const STORYLINE_NODE_MAX_HEIGHT_PX = 124;
export const STORYLINE_NODE_PORT_GAP_PX = 12;
export const STORYLINE_CONNECTOR_ELBOW_GAP_PX = 16;
export const STORYLINE_CONNECTOR_BRANCH_LENGTH_PX = 30;
export const STORYLINE_CONNECTOR_STROKE_WIDTH_PX = 3.2;
export const STORYLINE_TRACK_UNIFIED_COLOR_HEX = '#334155';
export const STORYLINE_TRACK_UNINVOLVED_COLOR_HEX = '#94a3b8';
export const STORYLINE_TICK_LABEL_HEIGHT_PX = 16;
export const STORYLINE_SLOT_MIN_LENGTH_PX = 58;
export const STORYLINE_INTERSPACE_MIN_LENGTH_PX = 58;
export const STORYLINE_SLOT_GLYPH_PADDING_PX = 18;
export const STORYLINE_SOLVER_ALIGN_ORDER_DELTA = 2;
export const STORYLINE_SOLVER_ROUTEBOX_CLEARANCE_PX = 8;
export const STORYLINE_SOLVER_D1_MIN_PX = 6;
export const STORYLINE_SOLVER_D1_MAX_PX = 18;
export const STORYLINE_SOLVER_D2_MIN_PX = 20;
export const STORYLINE_SOLVER_D2_MAX_PX = 56;
export const STORYLINE_SOLVER_OPT_ITERS = 60;
export const STORYLINE_SOLVER_OPT_STEP = 0.14;

// ============================================================================
// Coverage Grid Map (axis-encoded)
// ============================================================================

// User-defined column-combination controls (coverage map)
export const COVERAGE_MAP_MAX_COMBO_COLS = 3;

// Layout tuning (px)
export const COVERAGE_MAP_LABEL_COL_WIDTH = 220;
export const COVERAGE_MAP_CELL_WIDTH = 160;
export const COVERAGE_MAP_CELL_HEIGHT = 68;
export const COVERAGE_MAP_HEADER_HEIGHT = 44;

export const COVERAGE_MAP_MAX_DOTS_PER_CELL = 12;

// Legacy taxonomy (v0) - kept for backward compatibility with old runs
export const COVERAGE_TAXONOMY_V0 = [
  {
    id: 'data_quality',
    label: 'Data Quality Missingness',
    patterns: [
      'missing',
      'null',
      'nan',
      'duplicate',
      'inconsistent',
      'invalid',
      'data quality',
      'impute',
    ],
  },
  {
    id: 'outliers',
    label: 'Outliers Anomalies',
    patterns: ['outlier', 'anomal', 'rare', 'spike', 'extreme'],
  },
  {
    id: 'stat_test',
    label: 'Statistical Test',
    patterns: ['p-value', 'significant', 't-test', 'anova', 'chi-square', 'confidence interval'],
  },
  {
    id: 'modeling',
    label: 'Model Importance',
    patterns: [
      'regression',
      'classification',
      'predict',
      'feature importance',
      'shap',
      'model',
    ],
  },
  {
    id: 'trend_time',
    label: 'Trend Time',
    patterns: ['trend', 'over time', 'time series', 'year', 'month', 'season'],
  },
  {
    id: 'correlation',
    label: 'Correlation Relationship',
    patterns: ['correlation', 'relationship', 'association', 'pearson', 'spearman'],
  },
  {
    id: 'group_compare',
    label: 'Group Comparison',
    patterns: ['compare', 'difference', 'vs\\.?', 'across', 'by group', 'grouped by'],
  },
  {
    id: 'segmentation',
    label: 'Segmentation Clustering',
    patterns: ['cluster', 'segmentation', 'cohort', 'k-means', 'embedding'],
  },
  {
    id: 'distribution',
    label: 'Distribution',
    patterns: ['distribution', 'histogram', 'density', 'skew', 'percentile', 'quartile', 'boxplot'],
  },
  {
    id: 'unknown',
    label: 'Unknown',
    patterns: [],
  },
] as const;

export const INSIGHT_TAXONOMY_V1 = [
  { id: 'value', label: 'value' },
  { id: 'proportion', label: 'proportion' },
  { id: 'rank', label: 'rank' },
  { id: 'difference', label: 'difference' },
  { id: 'trend', label: 'trend' },
  { id: 'distribution', label: 'distribution' },
  { id: 'association', label: 'association' },
  { id: 'outlier', label: 'outlier' },
  { id: 'extreme', label: 'extreme' },
  { id: 'cluster', label: 'cluster' },
  { id: 'data_quality', label: 'data_quality' },
] as const;

export type InsightTaxonomyId = (typeof INSIGHT_TAXONOMY_V1)[number]['id'];

export const INSIGHT_TAXONOMY_COLORS: Record<
  InsightTaxonomyId,
  { tw: string; hex: string; hexLight: string }
> = {
  value: { tw: 'bg-indigo-100 text-indigo-700', hex: '#4338ca', hexLight: '#e0e7ff' },
  proportion: { tw: 'bg-amber-100 text-amber-700', hex: '#b45309', hexLight: '#fef3c7' },
  rank: { tw: 'bg-orange-100 text-orange-700', hex: '#c2410c', hexLight: '#ffedd5' },
  difference: { tw: 'bg-green-100 text-green-700', hex: '#15803d', hexLight: '#dcfce7' },
  trend: { tw: 'bg-blue-100 text-blue-700', hex: '#1d4ed8', hexLight: '#dbeafe' },
  distribution: {
    tw: 'bg-cyan-100 text-cyan-700',
    hex: '#0e7490',
    hexLight: '#cffafe',
  },
  association: { tw: 'bg-purple-100 text-purple-700', hex: '#7c3aed', hexLight: '#f3e8ff' },
  outlier: { tw: 'bg-red-100 text-red-700', hex: '#b91c1c', hexLight: '#fee2e2' },
  extreme: { tw: 'bg-pink-100 text-pink-700', hex: '#be185d', hexLight: '#fce7f3' },
  cluster: { tw: 'bg-teal-100 text-teal-700', hex: '#0f766e', hexLight: '#ccfbf1' },
  data_quality: { tw: 'bg-yellow-100 text-yellow-700', hex: '#a16207', hexLight: '#fef9c3' },
};

export const INSIGHT_TAXONOMY_FALLBACK_COLOR = {
  tw: 'bg-slate-100 text-slate-600',
  hex: '#475569',
  hexLight: '#f1f5f9',
};

// Plan log streaming tuning
export const MAX_LOG_ENTRIES_PER_PLAN = 10000;
export const PLAN_LOG_EVENT_TYPES = [
  'plan_log_delta',
  'plan_attempt_started',
  'plan_attempt_failed',
] as const;
export const PLAN_LOG_EVENT_TYPES_SET: ReadonlySet<string> = new Set(PLAN_LOG_EVENT_TYPES);

// Inspector feature flags
// Keep report generation capability in backend/store, but hide report UI by default.
export const SHOW_INSPECTOR_REPORT_UI = false;
