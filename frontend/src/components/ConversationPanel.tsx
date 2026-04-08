import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import { WORKSPACE_PANEL_HEADER_HEIGHT_PX } from '@/config';
import type { ConversationEntry, RunState, SteeringTargetSnapshot, Summary } from '@/types';
import ConversationHistory from '@/components/ConversationHistory';
import AgentActivityIndicator from '@/components/conversation/AgentActivityIndicator';
import ThinkingEntry from '@/components/conversation/ThinkingEntry';
import PlansCreatedEntry from '@/components/conversation/PlansCreatedEntry';
import PlansDispatchedEntry from '@/components/conversation/PlansDispatchedEntry';
import EvaluationEntry from '@/components/conversation/EvaluationEntry';
import SynthesisEntry from '@/components/conversation/SynthesisEntry';
import AgentResponseEntry from '@/components/conversation/AgentResponseEntry';
import SteeringActionEntry from '@/components/conversation/SteeringActionEntry';
import UserMessageEntry from '@/components/conversation/UserMessageEntry';
import StatusChangeEntry from '@/components/conversation/StatusChangeEntry';
import MarkCompleteEntry from '@/components/conversation/MarkCompleteEntry';
import SteerInput from '@/components/conversation/SteerInput';
import { getConversationInputPlaceholder, getRunActivityLabel } from '@/components/conversation/conversationUi';
import { useStore } from '@/store/useStore';

export function shouldSuppressSelectionScrollForSteeringReplay(target: SteeringTargetSnapshot): boolean {
  return target.kind === 'summary' || target.kind === 'atomic';
}

export function buildConversationTailKey(entries: readonly ConversationEntry[]): string | null {
  const tail = entries.at(-1);
  if (!tail) {
    return null;
  }
  return `${entries.length}:${tail.id}:${tail.type}`;
}

export function shouldForceScrollToLatestConversationEntry(args: {
  previousEntryCount: number;
  currentEntryCount: number;
  previousTailKey: string | null;
  currentTailKey: string | null;
  currentTailType: ConversationEntry['type'] | null;
}): boolean {
  const {
    previousEntryCount,
    currentEntryCount,
    previousTailKey,
    currentTailKey,
    currentTailType,
  } = args;
  if (!currentTailKey || currentTailKey === previousTailKey) {
    return false;
  }
  if (currentEntryCount <= previousEntryCount) {
    return false;
  }
  return currentTailType === 'user_message' || currentTailType === 'steering_action';
}

export function buildTargetSelectionScrollKey(
  target: SteeringTargetSnapshot
): string | null {
  if (target.kind === 'summary') {
    return `summary:${target.summary_id}:`;
  }
  if (target.kind === 'atomic') {
    return target.atomic_id ? `summary:${target.summary_id}:${target.atomic_id}` : null;
  }
  return null;
}

export function consumeSuppressedSelectionScroll(
  suppressedKeysRef: { current: Set<string> },
  selectionScrollKey: string | null
): boolean {
  if (!selectionScrollKey || !suppressedKeysRef.current.has(selectionScrollKey)) {
    return false;
  }
  suppressedKeysRef.current.delete(selectionScrollKey);
  return true;
}

type SelectionScrollDisposition = 'skip' | 'mark_handled' | 'scroll';

function buildSelectionScrollKey(
  selectedSummaryId: string | null,
  selectionType: string | null,
  atomicId?: string
): string | null {
  if (!selectedSummaryId || (selectionType !== 'summary' && selectionType !== 'insight')) {
    return null;
  }
  return `${selectionType}:${selectedSummaryId}:${atomicId ?? ''}`;
}

export function resolveSelectionScrollDisposition(args: {
  selectionScrollKey: string | null;
  lastHandledSelectionScrollKey: string | null;
  suppressed: boolean;
}): SelectionScrollDisposition {
  const { selectionScrollKey, lastHandledSelectionScrollKey, suppressed } = args;
  if (!selectionScrollKey || selectionScrollKey === lastHandledSelectionScrollKey) {
    return 'skip';
  }
  if (suppressed) {
    return 'mark_handled';
  }
  return 'scroll';
}

export function shouldDeactivateStickToBottomOnSummaryFocus(args: {
  hasScrollContainer: boolean;
  entryId: string | null;
  requestNonce: number | null;
  lastConsumedNonce: number | null;
}): boolean {
  const {
    hasScrollContainer,
    entryId,
    requestNonce,
    lastConsumedNonce,
  } = args;
  if (!hasScrollContainer || !entryId || requestNonce == null) {
    return false;
  }
  return lastConsumedNonce !== requestNonce;
}

export function resolveStickToBottomOnScroll(args: {
  isProgrammaticFocusScrollLocked: boolean;
  nearBottom: boolean;
}): boolean | null {
  const { isProgrammaticFocusScrollLocked, nearBottom } = args;
  if (isProgrammaticFocusScrollLocked) {
    return null;
  }
  return nearBottom;
}

const PROGRAMMATIC_FOCUS_SCROLL_SETTLE_MS = 180;

interface SteeringEntryFocusRequest {
  entryId: string;
  nonce: number;
}

interface SummaryEntryFocusRequest {
  entryId: string;
  nonce: number;
}

export default function ConversationPanel({
  runState,
  entries,
  planInsights,
  steerDraft,
  setSteerDraft,
  onSteerSubmit,
  isSendingSteer,
  steerError,
  onSelectPlan,
  onSelectInsight,
  mode,
  datasetPath,
  onDatasetPathChange,
  onUploadDataset,
  onNewConversation,
  onSelectConversation,
  inputPlaceholder,
  datasetError,
  uploadedDatasetName,
  uploadedDatasetSizeBytes,
  isUploadingDataset,
  lockDatasetSource = false,
  preserveDatasetSourceStyle = false,
  onActivateSteeringTarget,
  highlightedSteeringEntryId = null,
  steeringEntryFocusRequest = null,
  highlightedSummaryEntryId = null,
  summaryEntryFocusRequest = null,
  onFocusSummaryEntry,
}: {
  runState: RunState | null;
  entries: ConversationEntry[];
  planInsights: Map<string, Summary[]>;
  steerDraft: string;
  setSteerDraft: (value: string) => void;
  onSteerSubmit: (event: FormEvent<HTMLFormElement>) => void;
  isSendingSteer: boolean;
  steerError: string | null;
  onSelectPlan: (planId: string) => void;
  onSelectInsight: (insightId: string) => void;
  mode: 'new' | 'run';
  datasetPath: string;
  onDatasetPathChange: (value: string) => void;
  onUploadDataset?: (file: File) => Promise<void> | void;
  onNewConversation: () => void;
  onSelectConversation: (runId: string) => void;
  inputPlaceholder?: string;
  datasetError?: string | null;
  uploadedDatasetName?: string | null;
  uploadedDatasetSizeBytes?: number | null;
  isUploadingDataset?: boolean;
  lockDatasetSource?: boolean;
  preserveDatasetSourceStyle?: boolean;
  onActivateSteeringTarget?: (target: SteeringTargetSnapshot, sourceConversationEntryId?: string) => void;
  highlightedSteeringEntryId?: string | null;
  steeringEntryFocusRequest?: SteeringEntryFocusRequest | null;
  highlightedSummaryEntryId?: string | null;
  summaryEntryFocusRequest?: SummaryEntryFocusRequest | null;
  onFocusSummaryEntry?: (entryId: string, convergeIndex: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const suppressedSelectionScrollKeysRef = useRef<Set<string>>(new Set());
  const lastConsumedSteeringEntryFocusNonceRef = useRef<number | null>(null);
  const lastConsumedSummaryEntryFocusNonceRef = useRef<number | null>(null);
  const lastHandledSelectionScrollKeyRef = useRef<string | null>(null);
  const lastObservedEntryCountRef = useRef<number>(entries.length);
  const lastObservedTailKeyRef = useRef<string | null>(buildConversationTailKey(entries));
  const programmaticFocusScrollLockedRef = useRef(false);
  const programmaticFocusScrollUnlockTimerRef = useRef<number | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const selection = useStore((state) => state.selection);
  const selectedSummaryId =
    selection.id && (selection.type === 'summary' || selection.type === 'insight')
      ? selection.id
      : null;
  const selectedPlanId =
    selection.type === 'plan' && selection.id
      ? selection.id
      : null;
  const selectionScrollKey = buildSelectionScrollKey(
    selectedSummaryId,
    selection.type,
    selection.atomicId
  );
  const activityLabel = useMemo(() => getRunActivityLabel(runState), [runState]);
  const resolvedInputPlaceholder = useMemo(
    () => inputPlaceholder ?? getConversationInputPlaceholder(runState?.status),
    [inputPlaceholder, runState?.status]
  );
  const unlockProgrammaticFocusScroll = () => {
    programmaticFocusScrollLockedRef.current = false;
    if (
      programmaticFocusScrollUnlockTimerRef.current != null
      && typeof window !== 'undefined'
    ) {
      window.clearTimeout(programmaticFocusScrollUnlockTimerRef.current);
    }
    programmaticFocusScrollUnlockTimerRef.current = null;
  };
  const refreshProgrammaticFocusScrollLock = () => {
    if (typeof window === 'undefined') {
      return;
    }
    programmaticFocusScrollLockedRef.current = true;
    if (programmaticFocusScrollUnlockTimerRef.current != null) {
      window.clearTimeout(programmaticFocusScrollUnlockTimerRef.current);
    }
    programmaticFocusScrollUnlockTimerRef.current = window.setTimeout(() => {
      programmaticFocusScrollLockedRef.current = false;
      programmaticFocusScrollUnlockTimerRef.current = null;
    }, PROGRAMMATIC_FOCUS_SCROLL_SETTLE_MS);
  };
  const scrollConversationTargetIntoView = (target: HTMLElement) => {
    // Smooth focus scrolls can emit transient near-bottom scroll events before the
    // container has actually left the bottom, so keep stick-to-bottom frozen briefly.
    refreshProgrammaticFocusScrollLock();
    setStickToBottom(false);
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  useEffect(() => {
    const tail = entries.at(-1) ?? null;
    const currentTailKey = buildConversationTailKey(entries);
    const shouldForceScroll = shouldForceScrollToLatestConversationEntry({
      previousEntryCount: lastObservedEntryCountRef.current,
      currentEntryCount: entries.length,
      previousTailKey: lastObservedTailKeyRef.current,
      currentTailKey,
      currentTailType: tail?.type ?? null,
    });
    lastObservedEntryCountRef.current = entries.length;
    lastObservedTailKeyRef.current = currentTailKey;
    if (!shouldForceScroll || !scrollRef.current) {
      return;
    }
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    setStickToBottom(true);
  }, [entries]);

  useEffect(() => {
    if (!stickToBottom || !scrollRef.current) {
      return;
    }
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [activityLabel, entries, runState?.status, runState?.frontier, stickToBottom]);

  useEffect(() => {
    lastConsumedSteeringEntryFocusNonceRef.current = null;
    lastConsumedSummaryEntryFocusNonceRef.current = null;
    lastHandledSelectionScrollKeyRef.current = null;
    lastObservedEntryCountRef.current = entries.length;
    lastObservedTailKeyRef.current = buildConversationTailKey(entries);
    unlockProgrammaticFocusScroll();
  }, [runState?.run_id]);

  useEffect(() => {
    return () => {
      unlockProgrammaticFocusScroll();
    };
  }, []);

  useEffect(() => {
    if (!selectionScrollKey) {
      lastHandledSelectionScrollKeyRef.current = null;
      return;
    }
    const suppressed = consumeSuppressedSelectionScroll(
      suppressedSelectionScrollKeysRef,
      selectionScrollKey
    );
    const disposition = resolveSelectionScrollDisposition({
      selectionScrollKey,
      lastHandledSelectionScrollKey: lastHandledSelectionScrollKeyRef.current,
      suppressed,
    });
    if (disposition === 'skip') return;
    if (disposition === 'mark_handled') {
      lastHandledSelectionScrollKeyRef.current = selectionScrollKey;
      return;
    }
    if (!scrollRef.current || !selectedSummaryId) return;

    const candidates = Array.from(
      scrollRef.current.querySelectorAll<HTMLElement>('[data-summary-anchor-id]')
    ).filter((node) => node.dataset.summaryAnchorId === selectedSummaryId);
    const target = candidates.length > 0 ? candidates[candidates.length - 1] : null;
    if (!target) return;

    scrollConversationTargetIntoView(target);
    lastHandledSelectionScrollKeyRef.current = selectionScrollKey;
  }, [entries, selectedSummaryId, selectionScrollKey]);

  useEffect(() => {
    if (!scrollRef.current || !steeringEntryFocusRequest?.entryId) {
      return;
    }
    if (lastConsumedSteeringEntryFocusNonceRef.current === steeringEntryFocusRequest.nonce) {
      return;
    }
    const target = scrollRef.current.querySelector<HTMLElement>(
      `[data-conversation-entry-id="${steeringEntryFocusRequest.entryId}"]`
    );
    if (!target) {
      return;
    }
    lastConsumedSteeringEntryFocusNonceRef.current = steeringEntryFocusRequest.nonce;
    const planTarget = selectedPlanId
      ? target.querySelector<HTMLElement>(`[data-plan-dispatch-card-id="${selectedPlanId}"]`)
      : null;
    scrollConversationTargetIntoView(planTarget ?? target);
  }, [entries, selectedPlanId, steeringEntryFocusRequest]);

  useEffect(() => {
    const shouldFocus = shouldDeactivateStickToBottomOnSummaryFocus({
      hasScrollContainer: !!scrollRef.current,
      entryId: summaryEntryFocusRequest?.entryId ?? null,
      requestNonce: summaryEntryFocusRequest?.nonce ?? null,
      lastConsumedNonce: lastConsumedSummaryEntryFocusNonceRef.current,
    });
    if (!shouldFocus) {
      return;
    }
    if (!scrollRef.current || !summaryEntryFocusRequest) {
      return;
    }
    setStickToBottom(false);
    const target = scrollRef.current.querySelector<HTMLElement>(
      `[data-conversation-entry-id="${summaryEntryFocusRequest.entryId}"]`
    );
    if (!target) {
      return;
    }
    lastConsumedSummaryEntryFocusNonceRef.current = summaryEntryFocusRequest.nonce;
    scrollConversationTargetIntoView(target);
  }, [entries, summaryEntryFocusRequest]);

  const handleActivateTarget = (
    target: SteeringTargetSnapshot,
    sourceConversationEntryId?: string
  ) => {
    if (!onActivateSteeringTarget) {
      return;
    }
    if (shouldSuppressSelectionScrollForSteeringReplay(target)) {
      const selectionScrollKey = buildTargetSelectionScrollKey(target);
      if (selectionScrollKey) {
        suppressedSelectionScrollKeysRef.current.add(selectionScrollKey);
      }
    }
    onActivateSteeringTarget(target, sourceConversationEntryId);
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-white">
      <div
        className="flex flex-none items-center justify-between border-b border-slate-100 px-4"
        style={{ height: `${WORKSPACE_PANEL_HEADER_HEIGHT_PX}px` }}
      >
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">CHAT</h2>
        <ConversationHistory
          currentRunId={runState?.run_id}
          onNewConversation={onNewConversation}
          onSelectRun={onSelectConversation}
        />
      </div>

      <div
        className="relative flex-1 min-h-0"
      >
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const target = event.currentTarget;
            const nearBottom =
              target.scrollTop + target.clientHeight >= target.scrollHeight - 48;
            if (programmaticFocusScrollLockedRef.current) {
              refreshProgrammaticFocusScrollLock();
            }
            const nextStickToBottom = resolveStickToBottomOnScroll({
              isProgrammaticFocusScrollLocked: programmaticFocusScrollLockedRef.current,
              nearBottom,
            });
            if (nextStickToBottom == null) {
              return;
            }
            setStickToBottom(nextStickToBottom);
          }}
          className="h-full space-y-3 overflow-y-auto pb-4 px-4 pt-4"
        >
          {entries.length === 0 && mode === 'new' && (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
              Start a new conversation by uploading a CSV, then describing the analysis goal in the input box below.
            </div>
          )}
          {entries.map((entry) => {
            let content: ReactNode = null;
            switch (entry.type) {
              case 'thinking':
                content = <ThinkingEntry entry={entry} />;
                break;
              case 'plans_created':
                content = <PlansCreatedEntry entry={entry} />;
                break;
              case 'plans_dispatched':
                content = (
                  <PlansDispatchedEntry
                    entry={entry}
                    runState={runState}
                    planInsights={planInsights}
                    onSelectPlan={onSelectPlan}
                    onSelectInsight={onSelectInsight}
                    selectedPlanId={selectedPlanId}
                    selectedSummaryId={selectedSummaryId}
                  />
                );
                break;
              case 'evaluation':
                content = (
                  <EvaluationEntry
                    entry={entry}
                    isHighlighted={highlightedSummaryEntryId === entry.id}
                    onActivateCitation={onActivateSteeringTarget ? handleActivateTarget : undefined}
                    onFocus={
                      typeof entry.dispatchTurnIndex === 'number' && onFocusSummaryEntry
                        ? () => onFocusSummaryEntry(entry.id, entry.dispatchTurnIndex! + 1)
                        : undefined
                    }
                  />
                );
                break;
              case 'synthesis':
                content = <SynthesisEntry entry={entry} />;
                break;
              case 'agent_response':
                content = (
                  <AgentResponseEntry
                    entry={entry}
                    onActivateCitation={onActivateSteeringTarget ? handleActivateTarget : undefined}
                  />
                );
                break;
              case 'user_message':
                content = <UserMessageEntry entry={entry} />;
                break;
              case 'steering_action':
                content = (
                  <SteeringActionEntry
                    entry={entry}
                    isHighlighted={highlightedSteeringEntryId === entry.id}
                    onActivateTarget={onActivateSteeringTarget ? handleActivateTarget : undefined}
                  />
                );
                break;
              case 'status_change':
                content = <StatusChangeEntry entry={entry} />;
                break;
              case 'mark_complete':
                content = (
                  <MarkCompleteEntry
                    entry={entry}
                    isHighlighted={highlightedSummaryEntryId === entry.id}
                    onActivateCitation={onActivateSteeringTarget ? handleActivateTarget : undefined}
                    onFocus={
                      typeof entry.dispatchTurnIndex === 'number' && onFocusSummaryEntry
                        ? () => onFocusSummaryEntry(entry.id, entry.dispatchTurnIndex! + 1)
                        : undefined
                    }
                  />
                );
                break;
              default:
                content = null;
            }
            if (!content) {
              return null;
            }
            return (
              <div key={entry.id} data-conversation-entry-id={entry.id}>
                {content}
              </div>
            );
          })}
          {runState?.status === 'running' &&
            entries.at(-1)?.type !== 'mark_complete' && (
            <AgentActivityIndicator label={activityLabel} />
          )}
        </div>
      </div>

      <div className="relative">
        {!stickToBottom && (
          <div className="pointer-events-none absolute right-4 top-0 z-10 -translate-y-[calc(100%+0.5rem)]">
            <button
              type="button"
              onClick={() => {
                if (!scrollRef.current) return;
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                setStickToBottom(true);
              }}
              className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500 shadow-md transition hover:bg-slate-50"
            >
              <ArrowDown className="h-3 w-3" />
              Back to bottom
            </button>
          </div>
        )}

        <SteerInput
          value={steerDraft}
          onChange={setSteerDraft}
          onSubmit={onSteerSubmit}
          disabled={
            mode === 'run'
              ? !runState || !['running', 'paused', 'idle', 'completed'].includes(runState.status)
              : false
          }
          isSending={isSendingSteer}
          error={steerError}
          mode={mode}
          datasetPath={datasetPath}
          onDatasetPathChange={onDatasetPathChange}
          onUploadDataset={onUploadDataset}
          datasetError={datasetError ?? null}
          uploadedDatasetName={uploadedDatasetName ?? null}
          uploadedDatasetSizeBytes={uploadedDatasetSizeBytes ?? null}
          isUploadingDataset={Boolean(isUploadingDataset)}
          lockDatasetSource={lockDatasetSource}
          preserveDatasetSourceStyle={preserveDatasetSourceStyle}
          placeholder={resolvedInputPlaceholder}
        />
      </div>
    </div>
  );
}

