import type { CSSProperties, ReactNode } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Loader2,
  Pause,
  Pencil,
  Play,
  Square,
  XCircle,
} from 'lucide-react';
import type { PlanControlAction, PlanItem } from '@/types';

type PlanCardPlan = Pick<
  PlanItem,
  'plan_id' | 'text' | 'short_label' | 'status' | 'control_state' | 'launch_requested'
>;

export function isActivePlanStatus(status: PlanItem['status'] | undefined): boolean {
  return status === 'analyzing' || status === 'summarizing';
}

function resolveDisplayStatus(plan: PlanCardPlan | undefined): PlanItem['status'] | undefined {
  if (!plan) {
    return undefined;
  }
  if (plan.control_state === 'terminate_requested' && plan.status !== 'terminated') {
    return 'terminated';
  }
  if (plan.control_state === 'pause_requested' && plan.status !== 'paused') {
    return 'paused';
  }
  return plan.status;
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

export function isPlanModifySubmitKey(args: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}): boolean {
  return (
    args.key === 'Enter'
    && !args.shiftKey
    && !args.ctrlKey
    && !args.metaKey
    && !args.altKey
    && !args.isComposing
  );
}

export function PlanStatusBadge({ plan }: { plan: PlanCardPlan | undefined }) {
  const displayStatus = resolveDisplayStatus(plan);
  if (displayStatus === 'pending' && plan?.launch_requested) {
    return (
      <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-sky-100 px-2 text-[11px] font-medium leading-none text-sky-800">
        <Play className="h-3 w-3 fill-current" />
        launch requested
      </span>
    );
  }
  switch (displayStatus) {
    case 'paused':
      return (
        <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-amber-50 px-2 text-[11px] font-medium leading-none text-amber-700">
          <Clock3 className="h-3 w-3" />
          paused
        </span>
      );
    case 'terminated':
      return (
        <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-slate-100 px-2 text-[11px] font-medium leading-none text-slate-600">
          <XCircle className="h-3 w-3" />
          terminated
        </span>
      );
    case 'completed':
      return (
        <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-emerald-50 px-2 text-[11px] font-medium leading-none text-emerald-700">
          <CheckCircle2 className="h-3 w-3" />
          completed
        </span>
      );
    case 'analyzing':
      return (
        <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-sky-50 px-2 text-[11px] font-medium leading-none text-sky-700">
          <Loader2 className="h-3 w-3 animate-spin" />
          analyzing
        </span>
      );
    case 'summarizing':
      return (
        <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-violet-50 px-2 text-[11px] font-medium leading-none text-violet-700">
          <Loader2 className="h-3 w-3 animate-spin" />
          summarizing
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-rose-50 px-2 text-[11px] font-medium leading-none text-rose-700">
          <XCircle className="h-3 w-3" />
          failed
        </span>
      );
    default:
      return (
        <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-slate-100 px-2 text-[11px] font-medium leading-none text-slate-500">
          <Clock3 className="h-3 w-3" />
          pending
        </span>
      );
  }
}

function PlanIconButton({
  label,
  icon,
  disabled,
  classes,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  classes: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      className={[
        'inline-flex h-5 w-5 items-center justify-center rounded-md transition',
        classes,
        disabled ? 'cursor-not-allowed opacity-50' : '',
      ].join(' ')}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {icon}
    </button>
  );
}

function PlanControlIconButton({
  action,
  disabled,
  onClick,
}: {
  action: PlanControlAction;
  disabled: boolean;
  onClick: (action: PlanControlAction) => void;
}) {
  const icon =
    action === 'pause'
      ? <Pause className="h-3 w-3" />
      : action === 'launch'
        ? <Play className="h-3 w-3 fill-current" />
        : <Square className="h-3 w-3 fill-current" />;
  const label =
    action === 'pause'
      ? 'Pause'
      : action === 'launch'
        ? 'Launch'
        : 'Terminate';
  const classes =
    action === 'pause'
      ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
      : action === 'launch'
        ? 'bg-sky-100 text-sky-700 hover:bg-sky-200'
        : 'bg-rose-100 text-rose-700 hover:bg-rose-200';
  return (
    <PlanIconButton
      label={label}
      icon={icon}
      disabled={disabled}
      classes={classes}
      onClick={() => onClick(action)}
    />
  );
}

export default function PlanDispatchCard({
  planId,
  plan,
  selected = false,
  elapsedSeconds,
  pendingAction = null,
  disablePendingLaunchControl = false,
  disablePausedLaunchControl = false,
  variant = 'chat',
  accentVariant = 'default',
  hidePlanText = false,
  showChatDetails = true,
  canToggleChatDetails = false,
  onToggleChatDetails,
  onSelect,
  onControl,
  isEditing = false,
  modifyDraft = '',
  disableModifyControl = false,
  onModifyStart,
  onModifyDraftChange,
  onModifyCancel,
  onModifySubmit,
  style,
  children,
}: {
  planId: string;
  plan?: PlanCardPlan;
  selected?: boolean;
  elapsedSeconds?: number;
  pendingAction?: PlanControlAction | null;
  disablePendingLaunchControl?: boolean;
  disablePausedLaunchControl?: boolean;
  variant?: 'chat' | 'storyline';
  accentVariant?: 'default' | 'create';
  hidePlanText?: boolean;
  showChatDetails?: boolean;
  canToggleChatDetails?: boolean;
  onToggleChatDetails?: () => void;
  onSelect: () => void;
  onControl?: (action: PlanControlAction) => void;
  isEditing?: boolean;
  modifyDraft?: string;
  disableModifyControl?: boolean;
  onModifyStart?: () => void;
  onModifyDraftChange?: (value: string) => void;
  onModifyCancel?: () => void;
  onModifySubmit?: () => void;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const displayStatus = resolveDisplayStatus(plan);
  const isStorylineVariant = variant === 'storyline';
  const canModify = displayStatus === 'pending' || displayStatus === 'paused';
  const canModifyActive = displayStatus === 'analyzing' || displayStatus === 'summarizing';
  const canModifyAny = canModify || canModifyActive;
  const canLaunchPending = displayStatus === 'pending';
  const canPause = displayStatus === 'analyzing' || displayStatus === 'summarizing';
  const canLaunchPaused = displayStatus === 'paused';
  const canTerminate =
    displayStatus === 'pending'
    || displayStatus === 'paused'
    || displayStatus === 'analyzing'
    || displayStatus === 'summarizing';
  const isPauseDrainPending = displayStatus === 'paused' && plan?.control_state === 'pause_requested';
  const disableLaunchOrPause = isEditing || pendingAction !== null || plan?.control_state !== 'none';
  const disablePendingLaunch = disablePendingLaunchControl || disableLaunchOrPause || Boolean(plan?.launch_requested);
  const disablePausedLaunch = disablePausedLaunchControl
    || isEditing
    || pendingAction !== null
    || (plan?.control_state !== 'none' && !isPauseDrainPending);
  const disableTerminate = isEditing || pendingAction !== null || (
    plan?.control_state !== 'none'
    && !(displayStatus === 'paused' && isPauseDrainPending)
  );
  const disableModify = isEditing
    ? pendingAction !== null || modifyDraft.trim().length === 0
    : pendingAction !== null || disableModifyControl || !canModifyAny || Boolean(plan?.launch_requested);
  const isCreateAccent = accentVariant === 'create';
  const isExecuting = isStorylineVariant && isActivePlanStatus(displayStatus);
  const rootClasses = [
    'relative block w-full rounded-md border px-3 py-2.5 text-left shadow-sm transition',
    isStorylineVariant
      ? (
        isCreateAccent
          ? 'flex flex-col overflow-hidden bg-emerald-50/95 backdrop-blur-sm'
          : 'flex flex-col overflow-hidden bg-slate-50/95 backdrop-blur-sm'
      )
      : 'bg-slate-50',
    isStorylineVariant && isEditing ? 'h-full' : '',
    selected
      ? isStorylineVariant
        ? isCreateAccent
          ? 'border-emerald-700 ring-2 ring-inset ring-emerald-200/80 shadow-md'
          : 'border-slate-700 ring-2 ring-inset ring-slate-300/80 shadow-md'
        : 'border-sky-300 bg-sky-50 ring-2 ring-sky-200/70'
      : isStorylineVariant && isCreateAccent
        ? 'border-emerald-300 hover:border-emerald-400 hover:bg-emerald-100/80'
        : 'border-slate-200 hover:border-slate-300 hover:bg-slate-100/80',
  ].join(' ');
  const runningOverlayStyle = isExecuting
    ? ({
      ['--storyline-plan-pulse-shadow' as string]:
        isCreateAccent ? 'rgba(16, 185, 129, 0.22)' : 'rgba(56, 189, 248, 0.2)',
    } as CSSProperties)
    : undefined;

  const label = plan?.short_label || plan?.text || planId;
  const bodyText = plan?.text ?? planId;
  const hasSeparateBodyText = bodyText.trim() !== label.trim();
  const showPlanText = showChatDetails && !hidePlanText;
  const showStorylineBody = isEditing || showPlanText;
  const showStorylineModifyControl = isStorylineVariant && (Boolean(onModifyStart) || Boolean(onModifySubmit));
  const chatStatusRowClasses = [
    'flex min-w-0 items-center gap-1.5',
    showChatDetails ? 'mb-2' : '',
  ].join(' ').trim();
  const chatRootClasses = [
    rootClasses,
    showChatDetails ? '' : 'py-2',
  ].join(' ').trim();

  if (isStorylineVariant) {
    return (
      <div
        data-plan-dispatch-card-id={planId}
        data-plan-dispatch-card-selected={selected ? 'true' : undefined}
        data-plan-dispatch-card-accent={isCreateAccent ? 'create' : undefined}
        data-plan-dispatch-card-running={isExecuting ? 'true' : undefined}
        data-plan-dispatch-card-editing={isEditing ? 'true' : undefined}
        className={rootClasses}
        style={style}
      >
        {isExecuting ? (
          <span
            aria-hidden="true"
            className={[
              'pointer-events-none absolute inset-0 rounded-[inherit] border storyline-plan-card-running',
              isCreateAccent ? 'border-emerald-300' : 'border-sky-300',
            ].join(' ')}
            style={runningOverlayStyle}
          />
        ) : null}
        <div className="flex shrink-0 items-start gap-2">
          <button
            type="button"
            onClick={onSelect}
            className="min-w-0 flex-1 rounded-md text-left"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <PlanStatusBadge plan={plan} />
              {typeof elapsedSeconds === 'number' ? (
                <span className="text-[10px] tabular-nums text-slate-400">
                  {formatElapsed(elapsedSeconds)}
                </span>
              ) : null}
            </div>
          </button>

          {onControl ? (
            <div className="flex flex-none items-center gap-1.5 self-start">
              {showStorylineModifyControl ? (
                <PlanIconButton
                  label={isEditing ? 'Confirm' : 'Modify'}
                  icon={
                    isEditing
                      ? <Check className="h-3 w-3" />
                      : <Pencil className="h-3 w-3" />
                  }
                  disabled={disableModify}
                  classes={
                    isEditing
                      ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }
                  onClick={() => {
                    if (isEditing) {
                      onModifySubmit?.();
                      return;
                    }
                    onModifyStart?.();
                  }}
                />
              ) : null}
              {canLaunchPending ? (
                <PlanControlIconButton
                  action="launch"
                  disabled={disablePendingLaunch}
                  onClick={onControl}
                />
              ) : null}
              {canPause ? (
                <PlanControlIconButton
                  action="pause"
                  disabled={disableLaunchOrPause}
                  onClick={onControl}
                />
              ) : null}
              {canLaunchPaused ? (
                <PlanControlIconButton
                  action="launch"
                  disabled={disablePausedLaunch}
                  onClick={onControl}
                />
              ) : null}
              {canTerminate ? (
                <PlanControlIconButton
                  action="terminate"
                  disabled={disableTerminate}
                  onClick={onControl}
                />
              ) : null}
            </div>
          ) : null}
        </div>

        {showStorylineBody ? (
          isEditing ? (
            <div className="mt-2 min-h-0 flex-1">
              <textarea
                value={modifyDraft}
                aria-label="Edit plan text"
                className="h-full min-h-0 w-full resize-none overflow-y-auto rounded-md border border-slate-200 bg-white/90 px-3 py-2 text-sm leading-5 text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                onClick={(event) => {
                  event.stopPropagation();
                }}
                onChange={(event) => onModifyDraftChange?.(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    isPlanModifySubmitKey({
                      key: event.key,
                      shiftKey: event.shiftKey,
                      ctrlKey: event.ctrlKey,
                      metaKey: event.metaKey,
                      altKey: event.altKey,
                      isComposing: event.nativeEvent.isComposing,
                    })
                  ) {
                    event.preventDefault();
                    onModifySubmit?.();
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    onModifyCancel?.();
                  }
                }}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={onSelect}
              className="mt-2 block w-full min-h-0 overflow-hidden rounded-md text-left"
            >
              <div className="overflow-hidden break-words text-sm leading-5 text-slate-700">
                {label}
              </div>
              {hasSeparateBodyText ? (
                <div className="mt-2 overflow-hidden break-words text-[12px] leading-5 text-slate-600">
                  {bodyText}
                </div>
              ) : null}
            </button>
          )
        ) : null}

        {children}
      </div>
    );
  }

  return (
    <div
      data-plan-dispatch-card-id={planId}
      data-plan-dispatch-card-selected={selected ? 'true' : undefined}
      data-plan-dispatch-card-details-collapsed={!showChatDetails ? 'true' : undefined}
      data-plan-dispatch-card-details-collapsible={canToggleChatDetails ? 'true' : undefined}
      className={chatRootClasses}
      style={style}
    >
      <div className={showChatDetails ? 'flex items-start justify-between gap-2' : 'flex items-center justify-between gap-2'}>
        <button
          type="button"
          onClick={onSelect}
          className="block min-w-0 flex-1 rounded-md text-left"
        >
          <div className={chatStatusRowClasses}>
            <PlanStatusBadge plan={plan} />
            {typeof elapsedSeconds === 'number' ? (
              <span className="text-[10px] tabular-nums text-slate-400">
                {formatElapsed(elapsedSeconds)}
              </span>
            ) : null}
          </div>
          {showPlanText ? (
            <div className="break-words text-sm leading-5 text-slate-700">
              {label}
            </div>
          ) : null}
          {showChatDetails ? (
            <>
              <div className="mt-0.5 font-mono text-[10px] text-slate-400">
                {planId}
              </div>
              <div className="mt-2 text-[11px] font-medium text-slate-500">
                Open analysis stream
              </div>
            </>
          ) : null}
        </button>
        {canToggleChatDetails ? (
          <button
            type="button"
            data-plan-dispatch-card-toggle="true"
            data-plan-dispatch-card-toggle-expanded={showChatDetails ? 'true' : undefined}
            aria-label={showChatDetails ? 'Collapse analysis plan details' : 'Expand analysis plan details'}
            onClick={(event) => {
              event.stopPropagation();
              onToggleChatDetails?.();
            }}
            className="shrink-0 rounded-md p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-500"
          >
            {showChatDetails ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : null}
      </div>

      {showChatDetails ? children : null}
    </div>
  );
}




