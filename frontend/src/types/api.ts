export type ReportLanguage = 'en' | 'zh';

type ApiInsightType =
  | 'value'
  | 'proportion'
  | 'rank'
  | 'difference'
  | 'trend'
  | 'distribution'
  | 'association'
  | 'outlier'
  | 'extreme'
  | 'cluster'
  | 'data_quality';

export interface SteeringTargetSnapshot {
  kind: 'summary' | 'atomic' | 'column';
  summary_id: string;
  summary_short_label: string;
  summary_text: string;
  columns: string[];
  column_anchors?: Array<{
    column: string;
    converge_index: number;
  }>;
  atomic_id?: string;
  atomic_text?: string;
  insight_type?: ApiInsightType;
}

export interface ProvenanceCitation {
  marker: number;
  target: SteeringTargetSnapshot;
  label: string;
}

export interface StartRunRequest {
  dataset_path: string;
  user_goal: string;
  default_sub_agents_num?: number;
  max_concurrency?: number;
  max_initial_plans?: number;
  stable_output?: boolean;
}

export interface StartRunResponse {
  run_id: string;
  status: 'started' | 'error';
  error?: string;
}

export interface UpdateRunSettingsRequest {
  default_sub_agents_num: number;
}

export interface UpdateRunSettingsResponse {
  run_id: string;
  settings: {
    default_sub_agents_num: number;
    poll_interval_seconds?: number;
  };
}

export interface StopRunResponse {
  run_id: string;
  status: string;
  error?: string;
}

export type PlanControlAction = 'launch' | 'pause' | 'terminate' | 'modify';

export interface SteerRunRequest {
  content: string;
  kind?: 'chat' | 'focus' | 'ignore' | 'elaborate' | 'create' | 'dive_into' | 'cut_off' | 'suppress';
  display_text?: string;
  user_prompt?: string;
  system_prompt?: string;
  selected_keywords?: string[];
  target?: SteeringTargetSnapshot | null;
}

export interface SteerRunResponse {
  run_id: string;
  status: 'accepted' | 'error';
  message: {
    message_id: string;
    timestamp: string;
    content: string;
    kind?: 'chat' | 'focus' | 'ignore' | 'elaborate' | 'create' | 'dive_into' | 'cut_off' | 'suppress';
    display_text?: string;
    generated_prompt?: string;
    user_prompt?: string;
    system_prompt?: string;
    selected_keywords?: string[];
    target?: SteeringTargetSnapshot | null;
  };
  error?: string;
}

export interface GenerateReportRequest {
  insight_id: string;
  force?: boolean;
  language?: ReportLanguage;
}

export interface GenerateReportResponse {
  ok: boolean;
  insight_id?: string;
  report_path?: string;
  report_pack_path?: string;
  chain_insight_ids?: string[];
  created_at?: string;
  model?: string;
  language?: string;
  mode?: string;
  segment_count?: number;
  errors?: string[];
  preview?: string;
  error?: string;
}

export interface DatasetPreviewResponse {
  dataset_path: string;
  delimiter?: ',' | ';' | '\t' | '|';
  columns: string[];
  rows: string[][];
  row_count: number;
  offset: number;
  returned_rows: number;
  has_more: boolean;
}

export interface DatasetUploadResponse {
  dataset_path: string;
  original_filename: string;
  size_bytes: number;
  temporary: true;
}
