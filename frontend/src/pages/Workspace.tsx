import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Loader2, Table2, X } from 'lucide-react';
import clsx from 'clsx';

import {
  fetchEvents,
  fetchRunState,
  startRun,
  steerRun,
  subscribeToEvents,
  updateRunSettings,
  uploadDataset,
} from '@/api/client';
import ConversationPanel from '@/components/ConversationPanel';
import { getConversationInputPlaceholder } from '@/components/conversation/conversationUi';
import DataView from '@/components/DataView';
import ExplorationCoverageGrid, { type CoverageGridColorMode } from '@/components/ExplorationCoverageGrid';
import Inspector from '@/components/Inspector';
import StorylineGraph, {
  StorylinePenToolbar,
  type SteeringPenKind,
} from '@/components/StorylineGraph';
import { activateStorylineTarget } from '@/components/storylineTargetActivation';
import {
  buildCoverageGridModel,
} from '@/components/coverageGridModel';
import { useStorylineFilterController } from '@/components/storylineFilter';
import { WORKSPACE_PANEL_HEADER_HEIGHT_PX } from '@/config';
import { useStore } from '@/store/useStore';
import type { DatasetUploadResponse, Event, RunState, SteeringTargetSnapshot } from '@/types';
import { parseDatasetSchemaColumns } from '@/utils/datasetSchema';

const workspaceLogo = new URL('../assets/logo.svg', import.meta.url).href;

const ENDED_SESSION_ERROR = 'The analysis session has ended. Please start a new conversation.';
const DATA_TABLE_MODAL_MIN_WIDTH_PX = 560;
const DATA_TABLE_MODAL_MAX_WIDTH_VW = 95;
const DATA_TABLE_MODAL_ROW_INDEX_WIDTH_PX = 40;
const DATA_VIEW_CELL_WIDTH_PX = 80;

interface SteeringEntryFocusRequest {
  entryId: string;
  nonce: number;
}

interface SummaryEntryFocusRequest {
  entryId: string;
  nonce: number;
}

interface StorylineTurnFocusRequest {
  summaryId: string;
  nonce: number;
}

interface StorylinePlanFocusRequest {
  planId: string;
  nonce: number;
}

interface StorylineConvergeFocusRequest {
  convergeIndex: number;
  nonce: number;
}

interface UploadedDatasetState extends DatasetUploadResponse {}

interface IosToggleProps {
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
  falseLabel: ReactNode;
  trueLabel: ReactNode;
  disabled?: boolean;
  checkedTrackClassName?: string;
  uncheckedTrackClassName?: string;
  className?: string;
}

function IosToggle({
  checked,
  onChange,
  ariaLabel,
  falseLabel,
  trueLabel,
  disabled = false,
  checkedTrackClassName = 'bg-emerald-500',
  uncheckedTrackClassName = 'bg-slate-300',
  className,
}: IosToggleProps) {
  return (
    <div className={clsx('inline-flex items-center gap-2', className)}>
      <span
        className={clsx(
          'text-[11px] font-medium transition-colors',
          checked ? 'text-slate-400' : 'text-slate-700'
        )}
      >
        {falseLabel}
      </span>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={onChange}
        className={clsx(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent px-0.5 transition-colors duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          checked ? checkedTrackClassName : uncheckedTrackClassName
        )}
      >
        <span
          aria-hidden="true"
          className={clsx(
            'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform duration-200 ease-out',
            checked ? 'translate-x-5' : 'translate-x-0'
          )}
        />
      </button>

      <span
        className={clsx(
          'text-[11px] font-medium transition-colors',
          checked ? 'text-slate-700' : 'text-slate-400'
        )}
      >
        {trueLabel}
      </span>
    </div>
  );
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-slate-50/80">
      <div className="max-w-xs rounded-xl border border-dashed border-slate-200 bg-white px-6 py-8 text-center shadow-sm">
        <div className="text-sm font-medium text-slate-700">{title}</div>
        <div className="mt-2 text-sm leading-6 text-slate-400">{description}</div>
      </div>
    </div>
  );
}

export function shouldKeepRunLive(status?: RunState['status'] | null): boolean {
  return status === 'running' || status === 'paused' || status === 'idle' || status === 'completed';
}

export function isStartedRunTransition(
  runId: string | undefined,
  startedFromComposerRunId: string | null
): boolean {
  return Boolean(runId && startedFromComposerRunId && runId === startedFromComposerRunId);
}

export async function recoverRunAfterStreamError(
  runId: string,
  refreshRun: (runId: string) => Promise<RunState | null>
): Promise<{ status: RunState['status']; shouldKeepLive: boolean } | null> {
  const state = await refreshRun(runId);
  if (!state) {
    return null;
  }

  return {
    status: state.status,
    shouldKeepLive: shouldKeepRunLive(state.status),
  };
}

function normalizeColumnCount(columnCount: number): number {
  if (!Number.isFinite(columnCount)) return 0;
  return Math.max(0, Math.floor(columnCount));
}

function estimateDataTableModalWidthPx(columnCount: number): number {
  const safeCount = normalizeColumnCount(columnCount);
  const estimatedWidth = DATA_TABLE_MODAL_ROW_INDEX_WIDTH_PX + safeCount * DATA_VIEW_CELL_WIDTH_PX;
  return Math.max(DATA_TABLE_MODAL_MIN_WIDTH_PX, estimatedWidth);
}

export function buildDataTableModalWidth(columnCount: number): string {
  const widthPx = estimateDataTableModalWidthPx(columnCount);
  return `min(${DATA_TABLE_MODAL_MAX_WIDTH_VW}vw, ${widthPx}px)`;
}

export default function Workspace() {
  const location = useLocation();
  const navigate = useNavigate();
  const { runId } = useParams<{ runId: string }>();
  const isNewConversation = !runId;
  const startedFromComposerRunId =
    typeof (location.state as { startedFromComposerRunId?: unknown } | null)?.startedFromComposerRunId === 'string'
      ? ((location.state as { startedFromComposerRunId?: string }).startedFromComposerRunId ?? null)
      : null;
  const {
    runState,
    events,
    eventsLoading,
    setRunState,
    setEvents,
    applyEvent,
    setEventsLoading,
    clearPlanLogs,
    setCurrentRunId,
    resetConversation,
    upsertUserMessage,
    conversationEntries,
    planInsights,
    selection,
    setSelection,
  } = useStore();

  const [datasetDraft, setDatasetDraft] = useState('');
  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSendingSteer, setIsSendingSteer] = useState(false);
  const [steerDraft, setSteerDraft] = useState('');
  const [steerError, setSteerError] = useState<string | null>(null);
  const [showDataView, setShowDataView] = useState(false);
  const [coverageGridColorMode, setCoverageGridColorMode] = useState<CoverageGridColorMode>('count');
  const [highlightedSteeringEntryId, setHighlightedSteeringEntryId] = useState<string | null>(null);
  const [steeringEntryFocusRequest, setSteeringEntryFocusRequest] = useState<SteeringEntryFocusRequest | null>(null);
  const [highlightedSummaryEntryId, setHighlightedSummaryEntryId] = useState<string | null>(null);
  const [summaryEntryFocusRequest, setSummaryEntryFocusRequest] = useState<SummaryEntryFocusRequest | null>(null);
  const [storylineTurnFocusRequest, setStorylineTurnFocusRequest] = useState<StorylineTurnFocusRequest | null>(null);
  const [storylinePlanFocusRequest, setStorylinePlanFocusRequest] = useState<StorylinePlanFocusRequest | null>(null);
  const [storylineConvergeFocusRequest, setStorylineConvergeFocusRequest] =
    useState<StorylineConvergeFocusRequest | null>(null);
  const [activeSteeringPen, setActiveSteeringPen] = useState<SteeringPenKind | null>(null);
  const [isUploadingDataset, setIsUploadingDataset] = useState(false);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const [isUpdatingConcurrency, setIsUpdatingConcurrency] = useState(false);
  const [concurrencyError, setConcurrencyError] = useState<string | null>(null);
  const [uploadedDataset, setUploadedDataset] = useState<UploadedDatasetState | null>(null);
  const eventsCountRef = useRef(0);
  const isRecoveringStreamRef = useRef(false);
  const previousHasActiveFilterRef = useRef(false);

  useEffect(() => {
    if (runId) {
      setCurrentRunId(runId);
      void loadRunData(runId, { silent: isStartedRunTransition(runId, startedFromComposerRunId) });
    } else {
      setCurrentRunId(null);
      resetConversation();
      setError(null);
      setConcurrencyError(null);
      setIsLive(false);
    }
    return () => {
      clearPlanLogs();
    };
  }, [clearPlanLogs, resetConversation, runId, setCurrentRunId, startedFromComposerRunId]);

  useEffect(() => {
    eventsCountRef.current = events.length;
  }, [events.length]);

  useEffect(() => {
    if (
      runId &&
      runState &&
      ['running', 'paused', 'idle', 'completed'].includes(runState.status) &&
      isLive
    ) {
      const cleanup = subscribeToEvents(
        runId,
        (event: Event) => {
          applyEvent(event);
        },
        (streamError) => {
          console.error('Stream error:', streamError);
          if (!runId || isRecoveringStreamRef.current) {
            setIsLive(false);
            return;
          }
          isRecoveringStreamRef.current = true;
          setIsLive(false);
          void recoverRunAfterStreamError(runId, (nextRunId) =>
            loadRunData(nextRunId, { silent: true })
          )
            .then((recovered) => {
              setIsLive(recovered?.shouldKeepLive ?? false);
            })
            .finally(() => {
              isRecoveringStreamRef.current = false;
            });
        },
        { from: eventsCountRef.current }
      );
      return cleanup;
    }
  }, [runId, runState?.status, isLive]);

  const activeRunId = runId ?? runState?.run_id ?? '';
  const preserveStartedRunShell = isStartedRunTransition(runId, startedFromComposerRunId);
  const conversationDatasetPath = isNewConversation
    ? datasetDraft
    : (runState?.dataset_path ?? datasetDraft);

  const dataTableColumnCount = useMemo(
    () => parseDatasetSchemaColumns(runState?.dataset_schema ?? '').length,
    [runState?.dataset_schema]
  );
  const dataTableModalWidth = useMemo(
    () => buildDataTableModalWidth(dataTableColumnCount),
    [dataTableColumnCount]
  );
  const inputPlaceholder = useMemo(() => {
    if (isNewConversation) {
      return undefined;
    }
    return getConversationInputPlaceholder(runState?.status);
  }, [isNewConversation, runState?.status]);
  const coverageGridModel = useMemo(
    () => buildCoverageGridModel(runState),
    [runState]
  );
  const storylineFilter = useStorylineFilterController({
    coverageGridModel,
    runState,
  });

  const requestSteeringEntryFocus = (entryId: string) => {
    setHighlightedSummaryEntryId(null);
    setHighlightedSteeringEntryId(entryId);
    setSteeringEntryFocusRequest((current) => ({
      entryId,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  };

  const requestSteeringEntryHighlight = (entryId: string) => {
    setHighlightedSummaryEntryId(null);
    setHighlightedSteeringEntryId(entryId);
  };

  const requestSummaryEntryFocus = (entryId: string) => {
    setHighlightedSteeringEntryId(null);
    setHighlightedSummaryEntryId(entryId);
    setSummaryEntryFocusRequest((current) => ({
      entryId,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  };

  const requestStorylineConvergeFocus = (entryId: string, convergeIndex: number) => {
    setHighlightedSteeringEntryId(null);
    setHighlightedSummaryEntryId(entryId);
    setStorylineConvergeFocusRequest((current) => ({
      convergeIndex,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  };

  const requestStorylineTurnFocus = (summaryId: string) => {
    setStorylineTurnFocusRequest((current) => ({
      summaryId,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  };

  const requestStorylinePlanFocus = (planId: string) => {
    setStorylinePlanFocusRequest((current) => ({
      planId,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  };

  const handleActivateSteeringTarget = (
    target: SteeringTargetSnapshot,
    sourceConversationEntryId?: string
  ) => {
    if (sourceConversationEntryId) {
      requestSteeringEntryFocus(sourceConversationEntryId);
    }
    activateStorylineTarget({
      target,
      selection,
      setSelection,
      storylineFilterSnapshot: storylineFilter.snapshot,
      storylineFilterActions: storylineFilter.actions,
    });
    if ((target.kind === 'summary' || target.kind === 'atomic') && target.summary_id) {
      requestStorylineTurnFocus(target.summary_id);
    }
  };

  const handleSelectInsightInChat = (insightId: string) => {
    setSelection({ type: 'insight', id: insightId });
    requestStorylineTurnFocus(insightId);
  };

  useEffect(() => {
    const nextHasActiveFilter = storylineFilter.snapshot.hasActiveFilter;
    if (!previousHasActiveFilterRef.current && nextHasActiveFilter) {
      setSelection({ type: null, id: null });
    }
    previousHasActiveFilterRef.current = nextHasActiveFilter;
  }, [setSelection, storylineFilter.snapshot.hasActiveFilter]);

  useEffect(() => {
    setCoverageGridColorMode('count');
    previousHasActiveFilterRef.current = false;
    setHighlightedSteeringEntryId(null);
    setSteeringEntryFocusRequest(null);
    setHighlightedSummaryEntryId(null);
    setSummaryEntryFocusRequest(null);
    setStorylineTurnFocusRequest(null);
    setStorylineConvergeFocusRequest(null);
  }, [activeRunId]);

  useEffect(() => {
    setDatasetError(null);
    if (runId) {
      setIsUploadingDataset(false);
    }
  }, [runId]);

  useEffect(() => {
    if (!runId || !runState || !uploadedDataset) {
      return;
    }
    if (runState.dataset_path !== uploadedDataset.dataset_path) {
      setUploadedDataset(null);
    }
  }, [runId, runState, uploadedDataset]);

  async function loadRunData(id: string, options?: { silent?: boolean }) {
    if (!options?.silent) {
      setEventsLoading(true);
      setError(null);
    }

    try {
      const [state, evts] = await Promise.all([fetchRunState(id), fetchEvents(id)]);
      setRunState(state);
      setEvents(evts);
      setIsLive(shouldKeepRunLive(state.status));
      return state;
    } catch (err) {
      console.error('Failed to load run:', err);
      if (!options?.silent) {
        const message = err instanceof Error ? err.message : 'Failed to load run data';
        setError(message);
      }
      return null;
    } finally {
      if (!options?.silent) {
        setEventsLoading(false);
      }
    }
  }

  async function handleDefaultSubAgentsNumChange(nextValue: number) {
    if (!runState) {
      return;
    }
    const nextDefaultSubAgentsNum = Math.max(1, Math.min(6, Math.round(nextValue)));
    if (runState.settings.default_sub_agents_num === nextDefaultSubAgentsNum) {
      return;
    }

    const previousRunState = runState;
    setConcurrencyError(null);
    setIsUpdatingConcurrency(true);
    setRunState({
      ...runState,
      settings: {
        ...runState.settings,
        default_sub_agents_num: nextDefaultSubAgentsNum,
      },
    });

    try {
      const response = await updateRunSettings(runState.run_id, {
        default_sub_agents_num: nextDefaultSubAgentsNum,
      });
      const latestRunState = useStore.getState().runState;
      if (latestRunState?.run_id === runState.run_id) {
        setRunState({
          ...latestRunState,
          settings: {
            ...latestRunState.settings,
            ...response.settings,
          },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update default sub-agent count';
      setConcurrencyError(message);
      setRunState(previousRunState);
    } finally {
      setIsUpdatingConcurrency(false);
    }
  }

  async function handleSteerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = steerDraft.trim();
    if (!content) {
      setSteerError(isNewConversation ? 'Enter a goal to start the conversation' : 'Enter a steer message');
      return;
    }

    setIsSendingSteer(true);
    setSteerError(null);

    try {
      if (isNewConversation) {
        if (isUploadingDataset) {
          setSteerError('Wait for the CSV upload to finish');
          return;
        }
        const datasetPath = uploadedDataset?.dataset_path.trim() ?? '';
        if (!datasetPath) {
          setSteerError('Upload a dataset to start the conversation');
          return;
        }
        const response = await startRun({
          dataset_path: datasetPath,
          user_goal: content,
        });
        setSteerDraft('');
        navigate(`/c/${response.run_id}`, {
          state: {
            startedFromComposerRunId: response.run_id,
          },
        });
        return;
      }

      if (!runState || !activeRunId) return;
      if (!['running', 'paused', 'idle', 'completed'].includes(runState.status)) {
        setSteerError(`Run is not accepting messages (status=${runState.status})`);
        return;
      }

      const response = await steerRun(activeRunId, { content });
      upsertUserMessage(response.message);
      setIsLive(true);
      setSteerDraft('');
    } catch (err) {
      console.error('Failed to submit message:', err);
      const message = err instanceof Error ? err.message : 'Failed to submit message';
      setSteerError(
        message.includes('session has ended') ? ENDED_SESSION_ERROR : message
      );
    } finally {
      setIsSendingSteer(false);
    }
  }

  async function handleUploadDataset(file: File) {
    if (!isNewConversation) {
      return;
    }
    setDatasetError(null);
    setIsUploadingDataset(true);
    try {
      const response = await uploadDataset(file);
      setUploadedDataset(response);
      setDatasetDraft(response.dataset_path);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to upload dataset';
      setDatasetError(message);
    } finally {
      setIsUploadingDataset(false);
    }
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-center">
          <p className="mb-4 text-rose-600">{error}</p>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="text-sm text-slate-500 transition hover:text-slate-700"
          >
            Start a new conversation
          </button>
        </div>
      </div>
    );
  }

  if (eventsLoading || (!isNewConversation && !runState && !preserveStartedRunShell)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }

  const visibleDefaultSubAgentsNum = runState?.settings.default_sub_agents_num ?? 2;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-50">
      <header className="flex-none border-b border-slate-200 bg-[#7F929E]">
        <div className="flex h-12 items-center justify-between px-4">
          <div className="flex items-center">
            <img
              src={workspaceLogo}
              alt="Agentic EDA"
              className="h-7 w-auto"
            />
          </div>

          <div className="flex items-center gap-3">
            {runState ? (
              <>
                <label
                  className="flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-2.5 py-1 text-xs text-white/80"
                  title="Default sub-agent count. Updates are persisted now and applied when the system auto-fills dispatch concurrency."
                >
                  <span className="font-medium text-white">Default sub-agents</span>
                  <button
                    type="button"
                    disabled={isUpdatingConcurrency || visibleDefaultSubAgentsNum <= 1}
                    aria-label="Decrease default sub-agent count"
                    className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-white/20 bg-white/15 text-sm font-semibold text-white transition hover:bg-white/25 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => {
                      void handleDefaultSubAgentsNumChange(visibleDefaultSubAgentsNum - 1);
                    }}
                  >
                    -
                  </button>
                  <span
                    aria-label="Default sub-agent count"
                    className="min-w-5 text-center text-xs font-semibold text-white"
                  >
                    {visibleDefaultSubAgentsNum}
                  </span>
                  <button
                    type="button"
                    disabled={isUpdatingConcurrency || visibleDefaultSubAgentsNum >= 6}
                    aria-label="Increase default sub-agent count"
                    className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-white/20 bg-white/15 text-sm font-semibold text-white transition hover:bg-white/25 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => {
                      void handleDefaultSubAgentsNumChange(visibleDefaultSubAgentsNum + 1);
                    }}
                  >
                    +
                  </button>
                </label>
                <div className="flex items-center border-l border-white/20 pl-3 text-xs font-medium text-white/85">
                  <span>{runState.insights.length} summaries</span>
                </div>

                <button
                  type="button"
                  onClick={() => setShowDataView(true)}
                  className="rounded-md p-1.5 text-white/80 transition hover:bg-white/10 hover:text-white"
                  title="Show data table"
                >
                  <Table2 className="h-4 w-4" />
                </button>
                {concurrencyError ? (
                  <span className="text-xs text-rose-100">{concurrencyError}</span>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </header>

      <div
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns: '24rem minmax(0,1fr) 22rem' }}
      >
        <div className="min-h-0 min-w-0 overflow-hidden border-r border-slate-200">
          <ConversationPanel
            runState={runState}
            entries={conversationEntries}
            planInsights={planInsights}
            steerDraft={steerDraft}
            setSteerDraft={(value) => {
              setSteerDraft(value);
              if (steerError) setSteerError(null);
            }}
            onSteerSubmit={handleSteerSubmit}
            isSendingSteer={isSendingSteer}
            steerError={steerError}
            onSelectPlan={(planId) => {
              if (storylineFilter.snapshot.hasActiveFilter) {
                storylineFilter.actions.clearAll();
              }
              setSelection({ type: 'plan', id: planId });
              requestStorylinePlanFocus(planId);
            }}
            onSelectInsight={handleSelectInsightInChat}
            mode={isNewConversation ? 'new' : 'run'}
            datasetPath={conversationDatasetPath}
            onDatasetPathChange={(value) => {
              setDatasetDraft(value);
              if (datasetError) {
                setDatasetError(null);
              }
              if (uploadedDataset && uploadedDataset.dataset_path !== value.trim()) {
                setUploadedDataset(null);
              }
            }}
            onUploadDataset={handleUploadDataset}
            onNewConversation={() => {
              setSteerDraft('');
              setSteerError(null);
              setDatasetError(null);
              setUploadedDataset(null);
              setIsUploadingDataset(false);
              navigate('/');
            }}
            onSelectConversation={(nextRunId) => {
              setSteerDraft('');
              setSteerError(null);
              setDatasetError(null);
              setUploadedDataset(null);
              setIsUploadingDataset(false);
              navigate(`/c/${nextRunId}`);
            }}
            inputPlaceholder={inputPlaceholder}
            datasetError={datasetError}
            uploadedDatasetName={uploadedDataset?.original_filename ?? null}
            uploadedDatasetSizeBytes={uploadedDataset?.size_bytes ?? null}
            isUploadingDataset={isUploadingDataset}
            lockDatasetSource={!isNewConversation}
            preserveDatasetSourceStyle={preserveStartedRunShell}
            onActivateSteeringTarget={handleActivateSteeringTarget}
            highlightedSteeringEntryId={highlightedSteeringEntryId}
            steeringEntryFocusRequest={steeringEntryFocusRequest}
            highlightedSummaryEntryId={highlightedSummaryEntryId}
            summaryEntryFocusRequest={summaryEntryFocusRequest}
            onFocusSummaryEntry={requestStorylineConvergeFocus}
          />
        </div>

        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-white">
          <div
            data-storyline-panel-header="true"
            className="flex flex-none items-center justify-between gap-3 border-b border-slate-100 px-4"
            style={{ height: `${WORKSPACE_PANEL_HEADER_HEIGHT_PX}px` }}
          >
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Storyline
            </h2>
            {runState ? (
              <div
                data-storyline-header-pen-group="true"
                className="flex flex-wrap items-center gap-1"
              >
                <StorylinePenToolbar
                  placement="inline"
                  activeSteeringPen={activeSteeringPen}
                  pendingColumnPenSelection={null}
                  steeringActionError={null}
                  onTogglePen={(penKind) => {
                    setActiveSteeringPen((current) => (current === penKind ? null : penKind));
                  }}
                />
              </div>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {runState ? (
              <div className="h-full w-full min-h-0 relative overflow-hidden">
                <StorylineGraph
                  laneMode="dataset_columns"
                  storylineFilter={storylineFilter}
                  activeSteeringPen={activeSteeringPen}
                  onActiveSteeringPenChange={setActiveSteeringPen}
                  turnFocusRequest={storylineTurnFocusRequest}
                  planFocusRequest={storylinePlanFocusRequest}
                  convergeFocusRequest={storylineConvergeFocusRequest}
                  highlightedSummaryEntryId={highlightedSummaryEntryId}
                  onConversationEntryFocusRequest={requestSteeringEntryFocus}
                  onConversationEntryHighlightRequest={requestSteeringEntryHighlight}
                  onSummaryEntryFocusRequest={requestSummaryEntryFocus}
                />
              </div>
            ) : (
              <EmptyPanel
                title="Storyline is empty"
                description="Start a conversation to generate summary nodes and atomic-insight structure."
              />
            )}
          </div>
        </div>

        <div className="min-h-0 min-w-0 overflow-hidden border-l border-slate-200 bg-white">
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div
              className="flex min-h-0 flex-[0_0_30%] flex-col overflow-hidden border-b border-slate-200"
            >
              <div
                className="flex flex-none items-center justify-between border-b border-slate-100 px-4"
                style={{ height: `${WORKSPACE_PANEL_HEADER_HEIGHT_PX}px` }}
              >
                <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Inspector
                </h2>
                <IosToggle
                  checked={coverageGridColorMode === 'avg_importance'}
                  onChange={() => {
                    setCoverageGridColorMode((current) => (
                      current === 'count'
                        ? 'avg_importance'
                        : 'count'
                    ));
                  }}
                  ariaLabel="Toggle coverage grid color mode"
                  falseLabel="Count"
                  trueLabel="Importance"
                  checkedTrackClassName="bg-amber-500"
                  uncheckedTrackClassName="bg-blue-500"
                />
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                {runState ? (
                  <ExplorationCoverageGrid
                    model={coverageGridModel}
                    storylineFilter={storylineFilter}
                    colorMode={coverageGridColorMode}
                    onColorModeChange={setCoverageGridColorMode}
                  />
                ) : (
                  <EmptyPanel
                    title="Filter is empty"
                    description="Filter cells will appear here after the first run starts."
                  />
                )}
              </div>
            </div>

            <div className="flex min-h-0 flex-[0_0_70%] flex-col overflow-hidden">
              <div className="min-h-0 flex-1 overflow-hidden">
                {runState ? (
                  <Inspector
                    runId={activeRunId}
                    storylineFilter={storylineFilter.snapshot}
                  />
                ) : (
                  <EmptyPanel
                    title="Nothing selected"
                    description="Inspector details will appear here after the first run starts and insights are selected."
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {showDataView && runState && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setShowDataView(false)}
        >
          <div
            className="flex h-[70vh] max-w-[95vw] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
            style={{ width: dataTableModalWidth }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex h-10 items-center justify-between border-b border-slate-200 px-4">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Data Table
              </h2>
              <button
                type="button"
                onClick={() => setShowDataView(false)}
                className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <DataView
                runId={activeRunId}
                datasetPath={runState.dataset_path}
                datasetSchema={runState.dataset_schema}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

