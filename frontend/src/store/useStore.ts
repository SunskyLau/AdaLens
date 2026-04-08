/**
 * Global State Store using Zustand
 * 
 * Implements event-sourcing pattern:
 * - Events from backend are reduced to build current state
 * - State.json is used for initial load and validation
 * - Real-time log streaming for running plans
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type {
  ConversationEntry,
  RunState,
  Event,
  PlanItem,
  Summary,
  ExecutionRecord,
  Selection,
  Bookmark,
  Report,
  RunSummary,
  PlanLiveState,
  PlanLogEntry,
  PlanAttemptInfo,
  PlanLogChannel,
  ProvenanceCitation,
  UserMessage,
  WorkspaceViewMode,
} from '@/types';

import { MAX_LOG_ENTRIES_PER_PLAN, PLAN_LOG_EVENT_TYPES_SET } from '@/config';
import { normalizeSteeringActionKind, normalizeSteeringMessageKind } from '@/steering/kinds';
import {
  buildSteeringConversationEntryId,
  getSteeringTargetLabel,
  normalizeSteeringTargetSnapshot,
} from '@/steering/target';
import { normalizeCjkTerminalPunctuation } from '@/utils/textNormalization';

function filterTimelineEvents(events: Event[]): Event[] {
  return events.filter((event) => !PLAN_LOG_EVENT_TYPES_SET.has(event.event_type));
}

function buildEventIdentity(event: Event): string {
  return JSON.stringify([event.timestamp, event.event_type, event.data]);
}

function dedupeEvents(events: Event[]): Event[] {
  const seen = new Set<string>();
  const unique: Event[] = [];
  for (const event of events) {
    const identity = buildEventIdentity(event);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    unique.push(event);
  }
  return unique;
}

function normalizeConversationText(value: string | undefined): string {
  return normalizeCjkTerminalPunctuation(value ?? '').replace(/\s+/g, ' ').trim();
}

function isStatusChangeDuplicateOfEntry(
  statusEntry: ConversationEntry,
  entry: ConversationEntry
): boolean {
  if (statusEntry.type !== 'status_change') {
    return false;
  }

  const reason = normalizeConversationText(statusEntry.reason);
  if (!reason) {
    return false;
  }

  if (entry.type === 'mark_complete') {
    return reason === normalizeConversationText(entry.summary);
  }

  if (['synthesis', 'evaluation', 'agent_response'].includes(entry.type)) {
    return reason === normalizeConversationText(entry.text);
  }

  return false;
}

function isRedundantStatusChangeEntry(
  entry: ConversationEntry,
  existingEntries: ConversationEntry[]
): boolean {
  if (entry.type !== 'status_change') {
    return false;
  }

  const reason = normalizeConversationText(entry.reason);
  if (!reason) {
    return false;
  }

  for (let index = existingEntries.length - 1; index >= 0; index -= 1) {
    const existing = existingEntries[index];
    if (existing.type === 'status_change') {
      const sameReason = reason === normalizeConversationText(existing.reason);
      const sameStatus = (entry.status ?? '') === (existing.status ?? '');
      if (sameReason && sameStatus) {
        return true;
      }
      continue;
    }

    if (
      existing.type === 'mark_complete' &&
      reason === normalizeConversationText(existing.summary)
    ) {
      return true;
    }

    if (
      ['synthesis', 'evaluation', 'agent_response'].includes(existing.type) &&
      reason === normalizeConversationText(existing.text)
    ) {
      return true;
    }

    break;
  }

  return false;
}

function shouldAppendConversationEntry(
  entry: ConversationEntry,
  existingEntries: ConversationEntry[]
): boolean {
  if (isRedundantStatusChangeEntry(entry, existingEntries)) {
    return false;
  }
  return true;
}

function appendConversationEntry(
  existingEntries: ConversationEntry[],
  entry: ConversationEntry
): ConversationEntry[] {
  const existingIndex = existingEntries.findIndex((item) => item.id === entry.id);
  if (existingIndex >= 0) {
    return existingEntries.map((item, index) => (index === existingIndex ? entry : item));
  }

  if (!shouldAppendConversationEntry(entry, existingEntries)) {
    return existingEntries;
  }

  const previous = existingEntries[existingEntries.length - 1];
  if (previous && isStatusChangeDuplicateOfEntry(previous, entry)) {
    return [...existingEntries.slice(0, -1), entry];
  }

  return [...existingEntries, entry];
}

function createEmptyPlanLiveState(planId: string, attempt = 0): PlanLiveState {
  return {
    plan_id: planId,
    current_attempt: attempt,
    logs: [],
    attempts: [],
  };
}

function trimPlanLogs(logs: PlanLogEntry[]): PlanLogEntry[] {
  if (logs.length <= MAX_LOG_ENTRIES_PER_PLAN) return logs;
  return logs.slice(-MAX_LOG_ENTRIES_PER_PLAN);
}

function updatePlanLogsWithAttemptStart(
  existingLogs: Map<string, PlanLiveState>,
  planId: string,
  attempt: number,
  startedAt: string
): Map<string, PlanLiveState> {
  const next = new Map(existingLogs);
  const existing = next.get(planId) || createEmptyPlanLiveState(planId);
  const hasAttempt = existing.attempts.some((item) => item.attempt === attempt);
  const attemptInfo: PlanAttemptInfo = { attempt, started_at: startedAt };
  next.set(planId, {
    ...existing,
    current_attempt: attempt,
    attempts: hasAttempt ? existing.attempts : [...existing.attempts, attemptInfo],
  });
  return next;
}

function updatePlanLogsWithDelta(
  existingLogs: Map<string, PlanLiveState>,
  payload: {
    plan_id: string;
    channel: PlanLogChannel;
    delta: string;
    seq: number;
    attempt: number;
    timestamp: string;
  }
): Map<string, PlanLiveState> {
  const next = new Map(existingLogs);
  const existing = next.get(payload.plan_id) || createEmptyPlanLiveState(payload.plan_id, payload.attempt);
  const duplicate = existing.logs.some(
    (entry) =>
      entry.seq === payload.seq &&
      entry.attempt === payload.attempt &&
      entry.channel === payload.channel
  );
  if (duplicate) {
    return next;
  }
  const logEntry: PlanLogEntry = {
    channel: payload.channel,
    content: payload.delta,
    seq: payload.seq,
    attempt: payload.attempt,
    timestamp: payload.timestamp,
  };
  next.set(payload.plan_id, {
    ...existing,
    logs: trimPlanLogs([...existing.logs, logEntry]),
  });
  return next;
}

function updatePlanLogsWithAttemptFailure(
  existingLogs: Map<string, PlanLiveState>,
  payload: { plan_id: string; attempt: number; error_summary: string; timestamp: string }
): Map<string, PlanLiveState> {
  const next = new Map(existingLogs);
  const existing = next.get(payload.plan_id);
  if (!existing) return next;
  next.set(payload.plan_id, {
    ...existing,
    attempts: existing.attempts.map((attempt) =>
      attempt.attempt === payload.attempt
        ? { ...attempt, failed_at: payload.timestamp, error_summary: payload.error_summary }
        : attempt
    ),
  });
  return next;
}

function createEmptyMasterAgentState(): NonNullable<RunState['master_agent_state']> {
  return {
    current_goals: [],
    active_plan_ids: [],
    completed_plan_ids: [],
    all_insight_ids: [],
    dispatch_batches: [],
    pending_user_response_message_ids: [],
    message_history: [],
    loop_count: 0,
    completed: false,
  };
}

function usesDispatchAnchoredCreateProjection(runState: RunState | null | undefined): boolean {
  return Array.isArray(runState?.master_agent_state?.pending_direct_user_create_dispatch_plan_ids);
}

function upsertUserMessageList(messages: UserMessage[] | undefined, message: UserMessage): UserMessage[] {
  const existingMessages = messages ?? [];
  const existingIndex = existingMessages.findIndex((item) => item.message_id === message.message_id);
  if (existingIndex < 0) {
    return [...existingMessages, message];
  }
  return existingMessages.map((item, index) =>
    index === existingIndex ? { ...item, ...message } : item
  );
}

function normalizeKeywordList(keywords: string[] | null | undefined, limit = 10): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawKeyword of keywords ?? []) {
    const keyword = String(rawKeyword ?? '').trim();
    if (!keyword) {
      continue;
    }
    const lookupKey = keyword.toLocaleLowerCase();
    if (seen.has(lookupKey)) {
      continue;
    }
    seen.add(lookupKey);
    normalized.push(keyword);
    if (normalized.length >= limit) {
      break;
    }
  }
  return normalized;
}

function normalizeAtomicInsight(atomic: Summary['atomic_insights'][number]): Summary['atomic_insights'][number] {
  return {
    ...atomic,
    text: normalizeCjkTerminalPunctuation(atomic.text),
    keywords: normalizeKeywordList(atomic.keywords),
  };
}

function normalizeSummary(insight: Summary): Summary {
  return {
    ...insight,
    summary: normalizeCjkTerminalPunctuation(insight.summary),
    keywords: normalizeKeywordList(insight.keywords),
    atomic_insights: (insight.atomic_insights ?? []).map(normalizeAtomicInsight),
  };
}

function normalizeUserMessage(message: UserMessage): UserMessage {
  return {
    ...message,
    kind: normalizeSteeringMessageKind(message.kind),
    user_prompt: typeof message.user_prompt === 'string' ? message.user_prompt : undefined,
    system_prompt: typeof message.system_prompt === 'string' ? message.system_prompt : undefined,
    selected_keywords: normalizeKeywordList(message.selected_keywords),
    target: normalizeSteeringTargetSnapshot(message.target),
  };
}

function normalizeProvenanceCitation(
  citation: ProvenanceCitation | null | undefined
): ProvenanceCitation | null {
  if (!citation) {
    return null;
  }
  const marker = Number(citation.marker);
  if (!Number.isInteger(marker) || marker < 1) {
    return null;
  }
  const target = normalizeSteeringTargetSnapshot(citation.target);
  if (!target || (target.kind !== 'summary' && target.kind !== 'atomic')) {
    return null;
  }
  return {
    marker,
    target,
    label: (citation.label ?? '').trim() || getSteeringTargetLabel(target),
  };
}

function normalizeProvenanceCitations(
  citations: ProvenanceCitation[] | null | undefined
): ProvenanceCitation[] {
  const normalized: ProvenanceCitation[] = [];
  const seen = new Set<number>();
  for (const citation of citations ?? []) {
    const nextCitation = normalizeProvenanceCitation(citation);
    if (!nextCitation || seen.has(nextCitation.marker)) {
      continue;
    }
    seen.add(nextCitation.marker);
    normalized.push(nextCitation);
  }
  normalized.sort((a, b) => a.marker - b.marker);
  return normalized;
}

function normalizeDispatchBatches(
  batches: NonNullable<RunState['master_agent_state']>['dispatch_batches'] | undefined
): NonNullable<RunState['master_agent_state']>['dispatch_batches'] {
  return (batches ?? []).map((batch) => ({
    ...batch,
    plan_ids: Array.isArray(batch.plan_ids) ? batch.plan_ids.map((item) => String(item)) : [],
    batch_finished_user_response_emitted: Boolean(batch.batch_finished_user_response_emitted),
    stage_summary_markdown: batch.stage_summary_markdown ?? '',
    stage_summary_citations: normalizeProvenanceCitations(batch.stage_summary_citations),
  }));
}

function isNonterminalPlanStatus(status: PlanItem['status'] | undefined): boolean {
  return (
    status === 'pending'
    || status === 'analyzing'
    || status === 'summarizing'
    || status === 'paused'
  );
}

function upsertPlanInFrontier(
  frontier: PlanItem[],
  plan: PlanItem,
  options?: { prependIfMissing?: boolean }
): PlanItem[] {
  const existingIndex = frontier.findIndex((item) => item.plan_id === plan.plan_id);
  if (existingIndex >= 0) {
    return frontier.map((item, index) =>
      index === existingIndex ? { ...item, ...plan } : item
    );
  }
  if (options?.prependIfMissing === false) {
    return [...frontier, plan];
  }
  return [plan, ...frontier];
}

function getLatestUnresolvedDispatchBatchIndex(runState: RunState): number {
  const batches = runState.master_agent_state?.dispatch_batches ?? [];
  const planById = new Map(runState.frontier.map((plan) => [plan.plan_id, plan]));
  for (let index = batches.length - 1; index >= 0; index -= 1) {
    const batch = batches[index];
    if ((batch.plan_ids ?? []).some((planId) => isNonterminalPlanStatus(planById.get(planId)?.status))) {
      return index;
    }
  }
  return -1;
}

function insertPlanIdIntoDispatchBatchOrder(
  batchPlanIds: string[],
  planById: Map<string, PlanItem>,
  planId: string
): string[] {
  if (batchPlanIds.includes(planId)) {
    return batchPlanIds;
  }
  const runningIds: string[] = [];
  const nonrunningIds: string[] = [];
  const terminalIds: string[] = [];
  for (const existingPlanId of batchPlanIds) {
    const status = planById.get(existingPlanId)?.status;
    if (status === 'analyzing' || status === 'summarizing') {
      runningIds.push(existingPlanId);
      continue;
    }
    if (status === 'pending' || status === 'paused') {
      nonrunningIds.push(existingPlanId);
      continue;
    }
    terminalIds.push(existingPlanId);
  }
  return [...runningIds, ...nonrunningIds, planId, ...terminalIds];
}

function attachPlanIdToLatestUnresolvedDispatchBatch(runState: RunState, planId: string): RunState {
  const masterAgentState = runState.master_agent_state ?? createEmptyMasterAgentState();
  const batchIndex = getLatestUnresolvedDispatchBatchIndex(runState);
  if (batchIndex < 0) {
    return runState;
  }
  const planById = new Map(runState.frontier.map((plan) => [plan.plan_id, plan]));
  const nextBatches = normalizeDispatchBatches(masterAgentState.dispatch_batches).map((batch, index) =>
    index !== batchIndex
      ? batch
      : {
          ...batch,
          plan_ids: insertPlanIdIntoDispatchBatchOrder(batch.plan_ids ?? [], planById, planId),
        }
  );
  return {
    ...runState,
    master_agent_state: {
      ...masterAgentState,
      dispatch_batches: nextBatches,
    },
  };
}

function upsertDispatchBatchFromToolResult(
  runState: RunState,
  result: Record<string, unknown> | undefined
): RunState {
  const dispatchTurnIndex =
    typeof result?.dispatch_turn_index === 'number' ? result.dispatch_turn_index : null;
  if (dispatchTurnIndex === null) {
    return runState;
  }
  const explicitPlanIds = Array.isArray(result?.plan_ids)
    ? result.plan_ids.map((item) => String(item))
    : null;
  const dispatchedPlanIds = Array.isArray(result?.dispatched_plan_ids)
    ? result.dispatched_plan_ids.map((item) => String(item))
    : [];
  const nextPlanIds = explicitPlanIds ?? dispatchedPlanIds;
  if (nextPlanIds.length === 0) {
    return runState;
  }

  const masterAgentState = runState.master_agent_state ?? createEmptyMasterAgentState();
  const batches = normalizeDispatchBatches(masterAgentState.dispatch_batches);
  const existingIndex = batches.findIndex(
    (batch) => batch.dispatch_turn_index === dispatchTurnIndex
  );
  const mergedPlanIds =
    existingIndex >= 0 && explicitPlanIds == null
      ? [
          ...batches[existingIndex].plan_ids,
          ...dispatchedPlanIds.filter((planId) => !batches[existingIndex].plan_ids.includes(planId)),
        ]
      : nextPlanIds;

  const nextBatches =
    existingIndex >= 0
      ? batches.map((batch, index) =>
          index !== existingIndex
            ? batch
            : {
                ...batch,
                plan_ids: mergedPlanIds,
                status:
                  batch.status === 'stage_summarized' || batch.status === 'no_summary'
                    ? batch.status
                    : 'dispatched',
              }
        )
      : [
          ...batches,
          {
            dispatch_turn_index: dispatchTurnIndex,
            plan_ids: mergedPlanIds,
            status: 'dispatched' as const,
            stage_summary_emitted: false,
            batch_finished_user_response_emitted: false,
            stage_summary_markdown: '',
            stage_summary_citations: [],
          },
        ];

  nextBatches.sort((a, b) => a.dispatch_turn_index - b.dispatch_turn_index);

  return {
    ...runState,
    master_agent_state: {
      ...masterAgentState,
      dispatch_batches: nextBatches,
    },
  };
}

interface RunStateEventProjection {
  runState: RunState;
  pendingDispatchAnchoredCreateMessageIds: string[];
  appendedInsight: Summary | null;
}

function projectRunStateWithEvent(
  runState: RunState,
  event: Event,
  pendingDispatchAnchoredCreateMessageIds: string[]
): RunStateEventProjection {
  let nextRunState = runState;
  let nextPendingDispatchAnchoredCreateMessageIds = pendingDispatchAnchoredCreateMessageIds;
  let appendedInsight: Summary | null = null;

  switch (event.event_type) {
    case 'plan_created': {
      const plan = normalizePlanItem(event.data as PlanItem);
      nextRunState = {
        ...runState,
        frontier: upsertPlanInFrontier(runState.frontier, plan),
      };
      if (nextPendingDispatchAnchoredCreateMessageIds.length > 0) {
        nextPendingDispatchAnchoredCreateMessageIds =
          nextPendingDispatchAnchoredCreateMessageIds.slice(1);
        nextRunState = attachPlanIdToLatestUnresolvedDispatchBatch(nextRunState, plan.plan_id);
      }
      break;
    }

    case 'plan_started': {
      const plan = normalizePlanItem(event.data as PlanItem);
      const currentPlan = runState.frontier.find((item) => item.plan_id === plan.plan_id);
      if (!currentPlan || currentPlan.status !== plan.status) {
        nextRunState = {
          ...runState,
          frontier: upsertPlanInFrontier(runState.frontier, plan),
          step: runState.step + 1,
        };
      }
      break;
    }

    case 'plan_status_changed': {
      const plan = normalizePlanItem(event.data as PlanItem);
      nextRunState = {
        ...runState,
        frontier: upsertPlanInFrontier(runState.frontier, plan, { prependIfMissing: false }),
      };
      break;
    }

    case 'plan_completed': {
      const plan = normalizePlanItem(event.data as PlanItem);
      nextRunState = {
        ...runState,
        frontier: upsertPlanInFrontier(runState.frontier, plan, { prependIfMissing: false }),
      };
      break;
    }

    case 'execution_completed': {
      const record = event.data as ExecutionRecord;
      const recordKey = `${record.plan_id}:${record.created_at || ''}`;
      const existingRecord = runState.execution_records.find(
        (item) => `${item.plan_id}:${item.created_at || ''}` === recordKey
      );
      const nextFailureCount = existingRecord
        ? runState.failure_count
        : (record.success ? runState.failure_count : runState.failure_count + 1);
      nextRunState = {
        ...runState,
        execution_records: existingRecord
          ? runState.execution_records
          : [...runState.execution_records, record],
        failure_count: nextFailureCount,
      };
      break;
    }

    case 'insight_extracted': {
      const insight = normalizeSummary(event.data as Summary);
      const existingInsightIndex = runState.insights.findIndex(
        (item) => item.insight_id === insight.insight_id
      );
      nextRunState = {
        ...runState,
        insights:
          existingInsightIndex >= 0
            ? runState.insights.map((item, index) =>
                index === existingInsightIndex ? { ...item, ...insight } : item
              )
            : [...runState.insights, insight],
      };
      appendedInsight = insight;
      break;
    }

    case 'user_steer_received': {
      const message = normalizeUserMessage(event.data as UserMessage);
      nextRunState = upsertUserMessageInRunState(runState, message);
      if (
        usesDispatchAnchoredCreateProjection(nextRunState)
        && normalizeSteeringActionKind(message.kind) === 'create'
        && !nextPendingDispatchAnchoredCreateMessageIds.includes(message.message_id)
      ) {
        nextPendingDispatchAnchoredCreateMessageIds = [
          ...nextPendingDispatchAnchoredCreateMessageIds,
          message.message_id,
        ];
      }
      break;
    }

    case 'run_status_change': {
      const { new_status } = event.data as { new_status: RunState['status'] };
      nextRunState = {
        ...runState,
        status: new_status,
      };
      break;
    }

    case 'master_agent_tool_result': {
      const data = event.data as { tool_name?: string; result?: Record<string, unknown> };
      if (data.tool_name === 'mark_complete') {
        const summary =
          typeof data.result?.summary === 'string'
            ? normalizeCjkTerminalPunctuation(data.result.summary)
            : runState.final_summary ?? '';
        if (summary.trim()) {
          nextRunState = applyMarkCompleteToRunState(runState, summary);
        }
      } else if (data.tool_name === 'dispatch_plans') {
        nextRunState = upsertDispatchBatchFromToolResult(runState, data.result);
      }
      break;
    }

    case 'progress_evaluation': {
      nextRunState = applyProgressEvaluationToRunState(
        runState,
        event.data as {
          stage_summary_markdown?: string;
          dispatch_turn_index?: number;
          plan_ids?: string[];
          covered_dispatch_turn_indexes?: number[];
          citations?: ProvenanceCitation[];
        }
      );
      break;
    }

    case 'synthesis_update': {
      const { synthesis } = event.data as { synthesis: string };
      nextRunState = {
        ...runState,
        final_summary: normalizeCjkTerminalPunctuation(synthesis),
      };
      break;
    }

    case 'run_completed': {
      const { final_status } = event.data as { final_status: RunState['status'] };
      nextRunState = {
        ...runState,
        status: final_status,
      };
      break;
    }

    default:
      break;
  }

  return {
    runState: nextRunState,
    pendingDispatchAnchoredCreateMessageIds: nextPendingDispatchAnchoredCreateMessageIds,
    appendedInsight,
  };
}

function normalizePlanItem(plan: PlanItem): PlanItem {
  return {
    ...plan,
    control_state: plan.control_state ?? 'none',
    resume_phase: plan.resume_phase ?? null,
    checkpoint_path: plan.checkpoint_path ?? null,
    assigned_sub_agent_id: plan.assigned_sub_agent_id ?? null,
    final_summary:
      typeof plan.final_summary === 'string'
        ? normalizeCjkTerminalPunctuation(plan.final_summary)
        : null,
    error_message: plan.error_message ?? null,
  };
}

function normalizeRunSettings(runState: RunState): RunState['settings'] {
  const settings = runState.settings ?? ({ default_sub_agents_num: 2 } as RunState['settings']);
  const normalizedDefaultSubAgentsNum =
    typeof settings.default_sub_agents_num === 'number'
      ? settings.default_sub_agents_num
      : typeof settings.max_concurrency === 'number'
        ? settings.max_concurrency
        : 2;
  return {
    ...settings,
    default_sub_agents_num: normalizedDefaultSubAgentsNum,
  };
}

function upsertUserMessageInRunState(runState: RunState, message: UserMessage): RunState {
  const normalizedMessage = normalizeUserMessage(message);
  const userMessages = upsertUserMessageList(runState.user_messages, normalizedMessage);
  const masterAgentState = runState.master_agent_state ?? createEmptyMasterAgentState();
  const shouldResume =
    runState.status === 'completed' || runState.status === 'idle';

  return {
    ...runState,
    status: shouldResume ? 'running' : runState.status,
    user_messages: userMessages,
    master_agent_state: {
      ...masterAgentState,
      completed: shouldResume ? false : masterAgentState.completed,
    },
  };
}

function normalizeRunState(runState: RunState): RunState {
  const masterAgentState = runState.master_agent_state ?? createEmptyMasterAgentState();
  return {
    ...runState,
    settings: normalizeRunSettings(runState),
    frontier: (
      Array.isArray(runState.frontier)
        ? runState.frontier
        : Array.isArray(runState.plans)
          ? runState.plans
          : []
    ).map(normalizePlanItem),
    insights: (runState.insights ?? []).map(normalizeSummary),
    master_agent_state: {
      ...masterAgentState,
      dispatch_batches: normalizeDispatchBatches(masterAgentState.dispatch_batches),
      pending_direct_user_create_dispatch_plan_ids: Array.isArray(
        masterAgentState.pending_direct_user_create_dispatch_plan_ids
      )
        ? masterAgentState.pending_direct_user_create_dispatch_plan_ids.map((item) => String(item))
        : undefined,
    },
    user_messages: (runState.user_messages ?? []).map(normalizeUserMessage),
    final_summary: normalizeCjkTerminalPunctuation(runState.final_summary ?? ''),
  };
}

function buildUserConversationEntry(
  message: UserMessage,
  timestamp: string,
  runState?: RunState | null
): ConversationEntry | null {
  const normalizedMessage = normalizeUserMessage(message);
  const kind = normalizedMessage.kind ?? 'chat';
  const steeringActionKind = normalizeSteeringActionKind(kind);
  if (steeringActionKind) {
    if (steeringActionKind === 'create' && usesDispatchAnchoredCreateProjection(runState)) {
      return null;
    }
    const target = normalizedMessage.target ?? null;
    return {
      id: buildSteeringConversationEntryId(normalizedMessage.message_id),
      type: 'steering_action',
      timestamp,
      steeringKind: steeringActionKind,
      targetKind: target?.kind,
      targetLabel: target ? getSteeringTargetLabel(target) : undefined,
      target,
      displayText: normalizedMessage.display_text ?? normalizedMessage.content,
      generatedPrompt:
        normalizedMessage.user_prompt
        ?? normalizedMessage.generated_prompt
        ?? normalizedMessage.content,
      userPrompt:
        normalizedMessage.user_prompt
        ?? normalizedMessage.generated_prompt
        ?? normalizedMessage.content,
      systemPrompt: normalizedMessage.system_prompt,
      selectedKeywords: normalizedMessage.selected_keywords ?? [],
      text: normalizedMessage.display_text ?? normalizedMessage.content,
    };
  }
  return {
    id: buildSteeringConversationEntryId(normalizedMessage.message_id),
    type: 'user_message',
    timestamp,
    text: normalizedMessage.content ?? '',
  };
}

function appendPlanInsight(
  existing: Map<string, Summary[]>,
  insight: Summary
): Map<string, Summary[]> {
  const next = new Map(existing);
  const current = next.get(insight.plan_id) ?? [];
  const existingIndex = current.findIndex((item) => item.insight_id === insight.insight_id);
  const updated =
    existingIndex >= 0
      ? current.map((item, index) => (index === existingIndex ? insight : item))
      : [...current, insight];
  next.set(insight.plan_id, updated);
  return next;
}

function buildConversationEntry(
  event: Event,
  runState: RunState | null
): ConversationEntry | null {
  switch (event.event_type) {
    case 'master_agent_thinking': {
      const data = event.data as { loop_count?: number; thought?: string };
      let toolNames: string[] = [];
      if (typeof data.thought === 'string') {
        try {
          const parsed = JSON.parse(data.thought) as { tool_names?: string[] };
          toolNames = Array.isArray(parsed.tool_names) ? parsed.tool_names : [];
        } catch {
          toolNames = [];
        }
      }
      return {
        id: `${event.timestamp}:thinking`,
        type: 'thinking',
        timestamp: event.timestamp,
        loopCount: data.loop_count,
        toolNames,
        text: typeof data.thought === 'string' ? data.thought : '',
      };
    }
    case 'master_agent_tool_result': {
      const data = event.data as { tool_name?: string; result?: Record<string, unknown> };
      const result = data.result ?? {};
      if (data.tool_name === 'create_plans') {
        const rawPlans = Array.isArray(result.plans)
          ? (result.plans as PlanItem[])
          : [];
        const createdIds = Array.isArray(result.created_plan_ids)
          ? result.created_plan_ids.map((item) => String(item))
          : [];
        const plans =
          rawPlans.length > 0
            ? rawPlans.map(normalizePlanItem)
            : (runState?.frontier ?? []).filter((plan) => createdIds.includes(plan.plan_id));
        return {
          id: `${event.timestamp}:plans_created`,
          type: 'plans_created',
          timestamp: event.timestamp,
          plans,
          planIds: plans.map((plan) => plan.plan_id),
        };
      }
      if (data.tool_name === 'dispatch_plans') {
        const planIds = Array.isArray(result.plan_ids)
          ? result.plan_ids.map((item) => String(item))
          : Array.isArray(result.dispatched_plan_ids)
            ? result.dispatched_plan_ids.map((item) => String(item))
            : [];
        return {
          id: `${event.timestamp}:plans_dispatched`,
          type: 'plans_dispatched',
          timestamp: event.timestamp,
          planIds,
          dispatchTurnIndex:
            typeof result.dispatch_turn_index === 'number' ? result.dispatch_turn_index : undefined,
        };
      }
      if (data.tool_name === 'evaluate_progress') {
        return null;
      }
      if (data.tool_name === 'synthesize_findings') {
        return null;
      }
      if (data.tool_name === 'respond_to_user') {
        return null;
      }
      if (data.tool_name === 'mark_complete') {
        const summary =
          typeof result.summary === 'string'
            ? normalizeCjkTerminalPunctuation(result.summary)
            : '';
        if (!summary.trim()) {
          return null;
        }
        return {
          id: `${event.timestamp}:mark_complete`,
          type: 'mark_complete',
          timestamp: event.timestamp,
          summary,
          markdownBody: summary,
          dispatchTurnIndex:
            typeof result.dispatch_turn_index === 'number' ? result.dispatch_turn_index : undefined,
          citations: normalizeProvenanceCitations(result.citations as ProvenanceCitation[] | undefined),
        };
      }
      return null;
    }
    case 'progress_evaluation': {
      const data = event.data as {
        evaluation?: string;
        stage_summary_markdown?: string;
        dispatch_turn_index?: number;
        plan_ids?: string[];
        covered_dispatch_turn_indexes?: number[];
        citations?: ProvenanceCitation[];
      };
      const markdownBody = normalizeCjkTerminalPunctuation(
        data.stage_summary_markdown ?? data.evaluation ?? ''
      );
      return {
        id: `${event.timestamp}:evaluation`,
        type: 'evaluation',
        timestamp: event.timestamp,
        text: normalizeCjkTerminalPunctuation(data.evaluation ?? markdownBody),
        markdownBody,
        dispatchTurnIndex:
          typeof data.dispatch_turn_index === 'number' ? data.dispatch_turn_index : undefined,
        planIds: Array.isArray(data.plan_ids) ? data.plan_ids.map((item) => String(item)) : undefined,
        citations: normalizeProvenanceCitations(data.citations),
      };
    }
    case 'synthesis_update':
      return {
        id: `${event.timestamp}:synthesis`,
        type: 'synthesis',
        timestamp: event.timestamp,
        text: normalizeCjkTerminalPunctuation(
          (event.data as { synthesis?: string }).synthesis ?? ''
        ),
      };
    case 'user_response':
      {
        const data = event.data as {
          message?: string;
          citations?: ProvenanceCitation[];
        };
      return {
        id: `${event.timestamp}:agent_response`,
        type: 'agent_response',
        timestamp: event.timestamp,
        text: data.message ?? '',
        markdownBody: data.message ?? '',
        citations: normalizeProvenanceCitations(data.citations),
      };
      }
    case 'user_steer_received': {
      const message = normalizeUserMessage(event.data as UserMessage);
      return buildUserConversationEntry(message, event.timestamp, runState);
    }
    case 'run_status_change': {
      const data = event.data as { new_status?: string; reason?: string };
      if (data.new_status === 'completed') {
        return null;
      }
      return {
        id: `${event.timestamp}:status_change`,
        type: 'status_change',
        timestamp: event.timestamp,
        status: data.new_status,
        reason: data.reason,
      };
    }
    default:
      return null;
  }
}

function buildConversationEntries(events: Event[], runState: RunState | null): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const entry = buildConversationEntry(event, runState);
    if (!entry || seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    entries.splice(0, entries.length, ...appendConversationEntry(entries, entry));
  }
  return entries;
}

function applyMarkCompleteToRunState(runState: RunState, summary: string): RunState {
  const masterAgentState = runState.master_agent_state ?? createEmptyMasterAgentState();
  const normalizedSummary = normalizeCjkTerminalPunctuation(summary);
  return {
    ...runState,
    status: 'completed',
    final_summary: normalizedSummary || runState.final_summary || '',
    master_agent_state: {
      ...masterAgentState,
      completed: true,
    },
  };
}

function applyProgressEvaluationToRunState(
  runState: RunState,
  payload: {
    stage_summary_markdown?: string;
    dispatch_turn_index?: number;
    plan_ids?: string[];
    covered_dispatch_turn_indexes?: number[];
    citations?: ProvenanceCitation[];
  }
): RunState {
  const masterAgentState = runState.master_agent_state ?? createEmptyMasterAgentState();
  const dispatchTurnIndex =
    typeof payload.dispatch_turn_index === 'number' ? payload.dispatch_turn_index : null;
  if (dispatchTurnIndex === null) {
    return runState;
  }
  const coveredDispatchTurnIndexes = new Set(
    Array.isArray(payload.covered_dispatch_turn_indexes)
      ? payload.covered_dispatch_turn_indexes.filter(
          (item): item is number => typeof item === 'number'
        )
      : [dispatchTurnIndex]
  );

  return {
    ...runState,
    master_agent_state: {
      ...masterAgentState,
      dispatch_batches: normalizeDispatchBatches(
        masterAgentState.dispatch_batches.map((batch) =>
          !coveredDispatchTurnIndexes.has(batch.dispatch_turn_index)
            ? batch
            : {
                ...batch,
                status: 'stage_summarized',
                stage_summary_emitted: true,
                stage_summary_markdown:
                  batch.dispatch_turn_index === dispatchTurnIndex
                    ? normalizeCjkTerminalPunctuation(
                        payload.stage_summary_markdown ?? batch.stage_summary_markdown ?? ''
                      )
                    : batch.stage_summary_markdown ?? '',
                stage_summary_citations: normalizeProvenanceCitations(
                  batch.dispatch_turn_index === dispatchTurnIndex
                    ? payload.citations ?? batch.stage_summary_citations
                    : batch.stage_summary_citations
                ),
                plan_ids: Array.isArray(payload.plan_ids)
                  && batch.dispatch_turn_index === dispatchTurnIndex
                  ? payload.plan_ids.map((item) => String(item))
                  : batch.plan_ids,
              }
        )
      ),
    },
  };
}

function hydratePlanLogsAndReportsFromEvents(events: Event[]): {
  planLogs: Map<string, PlanLiveState>;
  reports: Record<string, Report>;
} {
  let planLogs = new Map<string, PlanLiveState>();
  const reports: Record<string, Report> = {};

  for (const event of events) {
    switch (event.event_type) {
      case 'plan_attempt_started': {
        const { plan_id, attempt } = event.data as { plan_id: string; attempt: number };
        planLogs = updatePlanLogsWithAttemptStart(planLogs, plan_id, attempt, event.timestamp);
        break;
      }
      case 'plan_log_delta': {
        const { plan_id, channel, delta, seq, attempt } = event.data as {
          plan_id: string;
          channel: PlanLogChannel;
          delta: string;
          seq: number;
          attempt: number;
        };
        planLogs = updatePlanLogsWithDelta(planLogs, {
          plan_id,
          channel,
          delta,
          seq,
          attempt,
          timestamp: event.timestamp,
        });
        break;
      }
      case 'plan_attempt_failed': {
        const { plan_id, attempt, error_summary } = event.data as {
          plan_id: string;
          attempt: number;
          error_summary: string;
        };
        planLogs = updatePlanLogsWithAttemptFailure(planLogs, {
          plan_id,
          attempt,
          error_summary,
          timestamp: event.timestamp,
        });
        break;
      }
      case 'report_generated': {
        const report = event.data as Report;
        if (report?.insight_id) {
          reports[report.insight_id] = report;
        }
        break;
      }
    }
  }

  return { planLogs, reports };
}

function syncRunStateStatusesFromEvents(
  runState: RunState,
  events: Event[]
): {
  runState: RunState;
  pendingDispatchAnchoredCreateMessageIds: string[];
} {
  let nextRunState = normalizeRunState(runState);
  let pendingDispatchAnchoredCreateMessageIds: string[] = [];
  for (const event of events) {
    const projection = projectRunStateWithEvent(
      nextRunState,
      event,
      pendingDispatchAnchoredCreateMessageIds
    );
    nextRunState = projection.runState;
    pendingDispatchAnchoredCreateMessageIds =
      projection.pendingDispatchAnchoredCreateMessageIds;
  }
  return {
    runState: nextRunState,
    pendingDispatchAnchoredCreateMessageIds,
  };
}

function buildInsightTreeFromRunState(runState: RunState): InsightTreeNode[] {
  // Build a deterministic plan-anchored tree. Each node is a plan paired with
  // its latest insight (if available), and child plans are linked via
  // plan.parent_insight_id -> parent insight -> parent plan.
  const plans = [...runState.frontier].sort((a, b) =>
    (a.created_at || '').localeCompare(b.created_at || '')
  );
  const executionByPlanId = new Map(runState.execution_records.map((record) => [record.plan_id, record]));

  const insightByPlanId = new Map<string, Summary>();
  const insightById = new Map<string, Summary>();
  for (const insight of runState.insights) {
    const existing = insightByPlanId.get(insight.plan_id);
    if (!existing || (insight.created_at || '') > (existing.created_at || '')) {
      insightByPlanId.set(insight.plan_id, insight);
    }
    insightById.set(insight.insight_id, insight);
  }

  const nodeByPlanId = new Map<string, InsightTreeNode>();
  for (const plan of plans) {
    nodeByPlanId.set(plan.plan_id, {
      plan,
      insight: insightByPlanId.get(plan.plan_id) || null,
      children: [],
      execution: executionByPlanId.get(plan.plan_id),
    });
  }

  const roots: InsightTreeNode[] = [];
  for (const plan of plans) {
    const node = nodeByPlanId.get(plan.plan_id);
    if (!node) continue;

    const parentInsightId = plan.parent_insight_id;
    if (!parentInsightId) {
      roots.push(node);
      continue;
    }

    const parentInsight = insightById.get(parentInsightId);
    const parentPlanId = parentInsight?.plan_id;
    if (parentPlanId) {
      const parentNode = nodeByPlanId.get(parentPlanId);
      if (parentNode) {
        parentNode.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  const sortNodes = (nodes: InsightTreeNode[]) => {
    nodes.sort((a, b) => (a.plan.created_at || '').localeCompare(b.plan.created_at || ''));
    for (const node of nodes) {
      if (node.children.length > 0) sortNodes(node.children);
    }
  };
  sortNodes(roots);
  return roots;
}

interface AppState {
  // Run list
  runs: RunSummary[];
  runsLoading: boolean;
  
  // Current run
  currentRunId: string | null;
  runState: RunState | null;
  events: Event[];
  timelineEvents: Event[];
  eventsLoading: boolean;
  
  // Real-time plan logs (for streaming output)
  planLogs: Map<string, PlanLiveState>;
  
  // UI selection
  selection: Selection;


  // Bookmarks (local state for now)
  bookmarks: Bookmark[];

  // Reports (keyed by insight_id)
  reports: Record<string, Report>;
  conversationEntries: ConversationEntry[];
  planInsights: Map<string, Summary[]>;
  viewMode: WorkspaceViewMode;
  pendingDispatchAnchoredCreateMessageIds: string[];
  
  // Actions
  setRuns: (runs: RunSummary[]) => void;
  setRunsLoading: (loading: boolean) => void;
  setCurrentRunId: (runId: string | null) => void;
  resetConversation: () => void;
  setRunState: (state: RunState | null) => void;
  setEvents: (events: Event[]) => void;
  addEvent: (event: Event) => void;
  applyEvent: (event: Event) => void;  // Apply event and update runState
  setEventsLoading: (loading: boolean) => void;
  setSelection: (selection: Selection) => void;
  addBookmark: (bookmark: Bookmark) => void;
  removeBookmark: (id: string) => void;
  clearPlanLogs: () => void;
  upsertReport: (report: Report) => void;
  upsertUserMessage: (message: UserMessage) => void;
  setViewMode: (viewMode: WorkspaceViewMode) => void;
  
  // Derived getters
  getInsightById: (id: string) => Summary | undefined;
  getPlanById: (id: string) => PlanItem | undefined;
  getExecutionByPlanId: (planId: string) => ExecutionRecord | undefined;
  getInsightTree: () => InsightTreeNode[];
  getPlanLogs: (planId: string) => PlanLiveState | undefined;
  getReportByInsightId: (insightId: string) => Report | undefined;
}

export interface InsightTreeNode {
  plan: PlanItem;
  insight: Summary | null;
  children: InsightTreeNode[];
  execution: ExecutionRecord | undefined;
}

export const useStore: UseBoundStore<StoreApi<AppState>> = create<AppState>((set, get) => ({
  // Initial state
  runs: [],
  runsLoading: false,
  currentRunId: null,
  runState: null,
  events: [],
  timelineEvents: [],
  eventsLoading: false,
  planLogs: new Map(),
  selection: { type: null, id: null },
  bookmarks: [],
  reports: {},
  conversationEntries: [],
  planInsights: new Map(),
  viewMode: 'conversation',
  pendingDispatchAnchoredCreateMessageIds: [],
  
  // Actions
  setRuns: (runs) => set({ runs }),
  setRunsLoading: (loading) => set({ runsLoading: loading }),
  setCurrentRunId: (runId) =>
    set({
      currentRunId: runId,
      planLogs: new Map(),
      pendingDispatchAnchoredCreateMessageIds: [],
    }),
  resetConversation: () =>
    set((state) => ({
      currentRunId: null,
      runState: null,
      events: [],
      timelineEvents: [],
      planLogs: new Map(),
      selection: { type: null, id: null },
      reports: {},
      conversationEntries: [],
      planInsights: new Map(),
      pendingDispatchAnchoredCreateMessageIds: [],
      runs: state.runs,
      runsLoading: state.runsLoading,
      eventsLoading: false,
    })),
  setRunState: (state) =>
    set(() => {
      const normalized = state ? normalizeRunState(state) : null;
      const planInsights = new Map<string, Summary[]>();
      for (const insight of normalized?.insights ?? []) {
        planInsights.set(insight.plan_id, [...(planInsights.get(insight.plan_id) ?? []), insight]);
      }
      return {
        runState: normalized,
        planInsights,
        pendingDispatchAnchoredCreateMessageIds: [],
      };
    }),
  setEvents: (events) => {
    const uniqueEvents = dedupeEvents(events);
    const hydrated = hydratePlanLogsAndReportsFromEvents(uniqueEvents);
    const currentRunState = get().runState;
    const replay = currentRunState
      ? syncRunStateStatusesFromEvents(currentRunState, uniqueEvents)
      : null;
    const updatedRunState = replay?.runState ?? currentRunState;
    const conversationEntries = buildConversationEntries(uniqueEvents, updatedRunState);
    const planInsights = new Map<string, Summary[]>();
    for (const insight of updatedRunState?.insights ?? []) {
      planInsights.set(insight.plan_id, [...(planInsights.get(insight.plan_id) ?? []), insight]);
    }

    set({
      events: uniqueEvents,
      timelineEvents: filterTimelineEvents(uniqueEvents),
      planLogs: hydrated.planLogs,
      runState: updatedRunState,
      reports: hydrated.reports,
      conversationEntries,
      planInsights,
      pendingDispatchAnchoredCreateMessageIds:
        replay?.pendingDispatchAnchoredCreateMessageIds ?? [],
    });
  },
  addEvent: (event) => set((state) => {
    const events = dedupeEvents([...state.events, event]);
    return {
      events,
      timelineEvents: filterTimelineEvents(events),
    };
  }),
  
  // Apply event and update runState incrementally
  applyEvent: (event) => {
    set((state) => {
      const eventIdentity = buildEventIdentity(event);
      if (state.events.some((existing) => buildEventIdentity(existing) === eventIdentity)) {
        return {};
      }

      const updatedEvents = [...state.events, event];
      const next: Partial<AppState> = {
        events: updatedEvents,
        timelineEvents: filterTimelineEvents(updatedEvents),
      };
      const conversationEntry = buildConversationEntry(event, state.runState);
      if (conversationEntry) {
        next.conversationEntries = appendConversationEntry(
          state.conversationEntries,
          conversationEntry
        );
      }

      // Log-stream events should still update even before runState hydration.
      if (event.event_type === 'plan_attempt_started') {
        const { plan_id, attempt } = event.data as { plan_id: string; attempt: number };
        next.planLogs = updatePlanLogsWithAttemptStart(state.planLogs, plan_id, attempt, event.timestamp);
      } else if (event.event_type === 'plan_log_delta') {
        const { plan_id, channel, delta, seq, attempt } = event.data as {
          plan_id: string;
          channel: PlanLogChannel;
          delta: string;
          seq: number;
          attempt: number;
        };
        next.planLogs = updatePlanLogsWithDelta(state.planLogs, {
          plan_id,
          channel,
          delta,
          seq,
          attempt,
          timestamp: event.timestamp,
        });
      } else if (event.event_type === 'plan_attempt_failed') {
        const { plan_id, attempt, error_summary } = event.data as {
          plan_id: string;
          attempt: number;
          error_summary: string;
        };
        next.planLogs = updatePlanLogsWithAttemptFailure(state.planLogs, {
          plan_id,
          attempt,
          error_summary,
          timestamp: event.timestamp,
        });
      } else if (event.event_type === 'report_generated') {
        const report = event.data as Report;
        if (report?.insight_id) {
          next.reports = {
            ...state.reports,
            [report.insight_id]: report,
          };
        }
      }

      const runState = state.runState;
      if (!runState) {
        return next;
      }

      const projection = projectRunStateWithEvent(
        runState,
        event,
        state.pendingDispatchAnchoredCreateMessageIds
      );
      next.runState = projection.runState;
      next.pendingDispatchAnchoredCreateMessageIds =
        projection.pendingDispatchAnchoredCreateMessageIds;
      if (projection.appendedInsight) {
        next.planInsights = appendPlanInsight(state.planInsights, projection.appendedInsight);
      }
      return next;
    });
  },
  
  setEventsLoading: (loading) => set({ eventsLoading: loading }),
  setSelection: (selection) => set({ selection }),
  addBookmark: (bookmark) => set((state) => ({
    bookmarks: [...state.bookmarks, bookmark]
  })),
  removeBookmark: (id) => set((state) => ({
    bookmarks: state.bookmarks.filter(b => b.id !== id)
  })),
  clearPlanLogs: () => set({ planLogs: new Map() }),
  upsertReport: (report) =>
    set((state) => ({
      reports: {
        ...state.reports,
        [report.insight_id]: report,
      },
    })),
  upsertUserMessage: (message) =>
    set((state) => {
      if (!state.runState) {
        return {};
      }
      const entry = buildUserConversationEntry(message, message.timestamp, state.runState);
      return {
        runState: upsertUserMessageInRunState(state.runState, message),
        conversationEntries: entry
          ? appendConversationEntry(state.conversationEntries, entry)
          : state.conversationEntries,
      };
    }),
  setViewMode: (viewMode) => set({ viewMode }),
  
  // Derived getters
  getInsightById: (id) => {
    const { runState } = get();
    return runState?.insights.find(i => i.insight_id === id);
  },
  
  getPlanById: (id) => {
    const { runState } = get();
    return runState?.frontier.find(p => p.plan_id === id);
  },
  
  getExecutionByPlanId: (planId) => {
    const { runState } = get();
    return runState?.execution_records.find(e => e.plan_id === planId);
  },
  
  getInsightTree: () => {
    const { runState } = get();
    if (!runState) return [];
    return buildInsightTreeFromRunState(runState);
  },
  
  getPlanLogs: (planId) => {
    const { planLogs } = get();
    return planLogs.get(planId);
  },

  getReportByInsightId: (insightId) => {
    const { reports } = get();
    return reports[insightId];
  },
}));
