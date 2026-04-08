import { normalizeSteeringMessageKind } from '@/steering/kinds';
import { buildSteeringConversationEntryId } from '@/steering/target';
import type { ConversationEntry, Event, RunState, TimelineEntry, UserMessage } from '@/types';

const STORYLINE_CREATE_POPOVER_PADDING_PX = 8;
const STORYLINE_CREATE_POPOVER_WIDTH_PX = 352;
const STORYLINE_CREATE_POPOVER_HEIGHT_PX = 260;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function planCreatedContent(entry: TimelineEntry): Record<string, unknown> | null {
  if (entry.entry_type !== 'plan_created') {
    return null;
  }
  return asObject(entry.content);
}

function buildCreateSteeringConversationEntryId(messageId: string): string {
  return buildSteeringConversationEntryId(messageId);
}

function appendCreateOriginPlanIdsFromRunState(
  planIds: Set<string>,
  runState: RunState | null | undefined
): void {
  for (const turn of runState?.turns ?? []) {
    for (const entry of turn.timeline ?? []) {
      const content = planCreatedContent(entry);
      if (!content || content.source !== 'user_create') {
        continue;
      }
      const planId = String(content.plan_id ?? '').trim();
      if (!planId) {
        continue;
      }
      planIds.add(planId);
    }
  }
}

function appendCreateMappingsFromRunState(
  mapping: Map<string, string>,
  runState: RunState | null | undefined
): void {
  for (const turn of runState?.turns ?? []) {
    for (const entry of turn.timeline ?? []) {
      const content = planCreatedContent(entry);
      if (!content || content.source !== 'user_create') {
        continue;
      }
      const planId = String(content.plan_id ?? '').trim();
      const messageId = String(content.message_id ?? '').trim();
      if (!planId || !messageId || mapping.has(planId)) {
        continue;
      }
      mapping.set(planId, buildCreateSteeringConversationEntryId(messageId));
    }
  }
}

function isCreateUserMessage(data: unknown): data is UserMessage {
  const message = asObject(data);
  if (!message) {
    return false;
  }
  return normalizeSteeringMessageKind(message.kind as string | undefined) === 'create';
}

function appendCreateMappingsFromEvents(
  mapping: Map<string, string>,
  events: readonly Event[] | null | undefined
): void {
  const pendingCreateEntryIds: string[] = [];
  for (const event of events ?? []) {
    if (event.event_type === 'user_steer_received') {
      if (!isCreateUserMessage(event.data)) {
        continue;
      }
      const messageId = String(event.data.message_id ?? '').trim();
      if (!messageId) {
        continue;
      }
      pendingCreateEntryIds.push(buildCreateSteeringConversationEntryId(messageId));
      continue;
    }

    if (event.event_type !== 'plan_created') {
      continue;
    }
    const content = asObject(event.data);
    const planId = String(content?.plan_id ?? '').trim();
    if (!planId || pendingCreateEntryIds.length === 0) {
      continue;
    }
    const nextCreateEntryId = pendingCreateEntryIds[0] ?? null;
    if (!nextCreateEntryId) {
      continue;
    }
    if (mapping.get(planId) === nextCreateEntryId) {
      pendingCreateEntryIds.shift();
      continue;
    }
    if (mapping.has(planId)) {
      continue;
    }
    mapping.set(planId, pendingCreateEntryIds.shift()!);
  }
}

function appendCreateOriginPlanIdsFromEvents(
  planIds: Set<string>,
  events: readonly Event[] | null | undefined
): void {
  let pendingCreateCount = 0;
  for (const event of events ?? []) {
    if (event.event_type === 'user_steer_received') {
      if (isCreateUserMessage(event.data)) {
        pendingCreateCount += 1;
      }
      continue;
    }
    if (event.event_type !== 'plan_created' || pendingCreateCount === 0) {
      continue;
    }
    const content = asObject(event.data);
    const planId = String(content?.plan_id ?? '').trim();
    if (!planId) {
      continue;
    }
    pendingCreateCount -= 1;
    planIds.add(planId);
  }
}

function buildLegacyCreateConversationEntryIds(
  conversationEntries: readonly ConversationEntry[] | null | undefined
): Set<string> {
  const entryIds = new Set<string>();
  for (const entry of conversationEntries ?? []) {
    if (entry.type !== 'steering_action' || entry.steeringKind !== 'create') {
      continue;
    }
    entryIds.add(entry.id);
  }
  return entryIds;
}

export function buildCreateOriginPlanIds(
  runState: RunState | null | undefined,
  events?: readonly Event[] | null
): Set<string> {
  const planIds = new Set<string>();
  appendCreateOriginPlanIdsFromRunState(planIds, runState);
  appendCreateOriginPlanIdsFromEvents(planIds, events);
  return planIds;
}

export function buildCreateSteeringEntryIdByPlanId(
  runState: RunState | null | undefined,
  events?: readonly Event[] | null,
  conversationEntries?: readonly ConversationEntry[] | null
): Map<string, string> {
  const mapping = new Map<string, string>();
  appendCreateMappingsFromRunState(mapping, runState);
  appendCreateMappingsFromEvents(mapping, events);
  if (!conversationEntries) {
    return mapping;
  }
  const availableEntryIds = buildLegacyCreateConversationEntryIds(conversationEntries);
  for (const [planId, entryId] of [...mapping.entries()]) {
    if (!availableEntryIds.has(entryId)) {
      mapping.delete(planId);
    }
  }
  return mapping;
}

export function buildCreateOriginSummaryIds(
  runState: RunState | null | undefined,
  createOriginPlanIds: ReadonlySet<string>
): Set<string> {
  const summaryIds = new Set<string>();
  for (const summary of runState?.insights ?? []) {
    if (!createOriginPlanIds.has(summary.plan_id)) {
      continue;
    }
    summaryIds.add(summary.insight_id);
  }
  return summaryIds;
}

export function buildCreateSteeringEntryIdBySummaryId(
  runState: RunState | null | undefined,
  createSteeringEntryIdByPlanId: ReadonlyMap<string, string>
): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const summary of runState?.insights ?? []) {
    const conversationEntryId = createSteeringEntryIdByPlanId.get(summary.plan_id);
    if (!conversationEntryId || mapping.has(summary.insight_id)) {
      continue;
    }
    mapping.set(summary.insight_id, conversationEntryId);
  }
  return mapping;
}

export function resolvePreferredConversationEntryForPlan(args: {
  planId: string;
  createSteeringEntryIdByPlanId: ReadonlyMap<string, string>;
  dispatchConversationEntryIdByPlanId: ReadonlyMap<string, string>;
}): string | null {
  const dispatchEntryId = args.dispatchConversationEntryIdByPlanId.get(args.planId);
  if (dispatchEntryId) {
    return dispatchEntryId;
  }
  const createEntryId = args.createSteeringEntryIdByPlanId.get(args.planId);
  if (createEntryId) {
    return createEntryId;
  }
  return null;
}

export function isCreatePopoverSubmitKey(args: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
}): boolean {
  return args.key === 'Enter' && !args.shiftKey && !args.isComposing;
}

export function resolveStorylineCreatePopoverPosition(args: {
  popover: Pick<{ x: number; y: number }, 'x' | 'y'>;
  viewport: { width: number; height: number };
  widthPx?: number;
  heightPx?: number;
  paddingPx?: number;
}): { left: number; top: number } {
  const widthPx = args.widthPx ?? STORYLINE_CREATE_POPOVER_WIDTH_PX;
  const heightPx = args.heightPx ?? STORYLINE_CREATE_POPOVER_HEIGHT_PX;
  const paddingPx = args.paddingPx ?? STORYLINE_CREATE_POPOVER_PADDING_PX;
  return {
    left: Math.max(
      paddingPx,
      Math.min(args.popover.x, Math.max(paddingPx, args.viewport.width - widthPx - paddingPx))
    ),
    top: Math.max(
      paddingPx,
      Math.min(args.popover.y, Math.max(paddingPx, args.viewport.height - heightPx - paddingPx))
    ),
  };
}
