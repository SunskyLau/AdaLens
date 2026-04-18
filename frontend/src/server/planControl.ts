export type PlanControlAction =
  | 'launch'
  | 'pause'
  | 'terminate'
  | 'modify';

export type PlanRecord = Record<string, unknown> & {
  plan_id?: string;
  text?: string;
  status?: string;
  control_state?: string;
  resume_phase?: string | null;
  checkpoint_path?: string | null;
  pending_modified_text?: string | null;
  launch_requested?: boolean;
  revision?: number;
  final_summary?: string | null;
  error_message?: string | null;
};

export function applyPlanControlToPlanRecord(
  plan: PlanRecord,
  action: PlanControlAction
): { allowed: boolean; changed: boolean } {
  const status = typeof plan.status === 'string' ? plan.status : 'pending';

  if (action === 'pause') {
    return {
      allowed: status === 'pending' || status === 'analyzing' || status === 'summarizing',
      changed: false,
    };
  }

  if (action === 'launch') {
    return { allowed: status === 'paused' || status === 'pending', changed: false };
  }

  if (action === 'modify') {
    return {
      allowed:
        status === 'pending'
        || status === 'paused'
        || status === 'analyzing'
        || status === 'summarizing',
      changed: false,
    };
  }

  return {
    allowed:
      status === 'pending'
      || status === 'paused'
      || status === 'analyzing'
      || status === 'summarizing',
    changed: false,
  };
}

function normalizePlanText(text: unknown): string {
  return String(text ?? '').trim();
}

function applyConfirmedModificationPreview(
  plan: PlanRecord,
  nextText: string
): PlanRecord {
  const normalizedCurrent = normalizePlanText(plan.text);
  const normalizedNext = normalizePlanText(nextText);
  const nextPlan: PlanRecord = {
    ...plan,
    pending_modified_text: null,
    status: 'pending',
    control_state: 'none',
    launch_requested: true,
  };
  if (normalizedNext === normalizedCurrent) {
    return nextPlan;
  }
  return {
    ...nextPlan,
    text: nextText,
    resume_phase: null,
    checkpoint_path: null,
    revision:
      typeof plan.revision === 'number' && Number.isFinite(plan.revision)
        ? Math.trunc(plan.revision) + 1
        : 2,
    final_summary: null,
    error_message: null,
  };
}

export function applyPlanControlPreviewToPlanRecord(args: {
  plan: PlanRecord;
  action: PlanControlAction;
  userAuthoredText?: string;
}): PlanRecord {
  const { action } = args;
  const nextPlan: PlanRecord = { ...args.plan };
  const nextText = normalizePlanText(args.userAuthoredText);
  const status = typeof nextPlan.status === 'string' ? nextPlan.status : 'pending';

  if (action === 'pause') {
    nextPlan.launch_requested = false;
    if (status === 'pending') {
      nextPlan.status = 'paused';
      nextPlan.control_state = 'none';
      return nextPlan;
    }
    if (status === 'analyzing' || status === 'summarizing') {
      nextPlan.control_state = 'pause_requested';
    }
    return nextPlan;
  }

  if (action === 'launch') {
    nextPlan.status = 'pending';
    nextPlan.control_state = 'none';
    nextPlan.launch_requested = true;
    if (nextPlan.resume_phase !== 'analyzing' && nextPlan.resume_phase !== 'summarizing') {
      nextPlan.resume_phase = null;
    }
    return nextPlan;
  }

  if (action === 'terminate') {
    nextPlan.launch_requested = false;
    if (status === 'pending' || status === 'paused') {
      nextPlan.status = 'terminated';
      nextPlan.control_state = 'none';
      return nextPlan;
    }
    if (status === 'analyzing' || status === 'summarizing') {
      nextPlan.control_state = 'terminate_requested';
    }
    return nextPlan;
  }

  if (action === 'modify' && nextText) {
    if (status === 'analyzing' || status === 'summarizing') {
      return {
        ...nextPlan,
        pending_modified_text: nextText,
        control_state: 'pause_requested',
        launch_requested: false,
      };
    }
    return applyConfirmedModificationPreview(nextPlan, nextText);
  }

  return nextPlan;
}

export function buildPlanControlResponse(args: {
  plan: PlanRecord;
  action: PlanControlAction;
  persistedRunStatus: string;
  userAuthoredText?: string;
}): {
  plan: PlanRecord;
  runStatus: string;
  emitPlanStatusChanged: boolean;
} {
  const previewPlan = applyPlanControlPreviewToPlanRecord({
    plan: args.plan,
    action: args.action,
    userAuthoredText: args.userAuthoredText,
  });
  return {
    plan: previewPlan,
    runStatus: args.persistedRunStatus,
    emitPlanStatusChanged: false,
  };
}
