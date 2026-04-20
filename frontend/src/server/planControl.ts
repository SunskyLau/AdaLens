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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export type PlanControlRequestRecord = {
  plan_id: string;
  action: PlanControlAction;
  timestamp: string;
  user_authored_text?: string;
};

function isNonterminalPlanStatus(status: string): boolean {
  return (
    status === 'pending'
    || status === 'paused'
    || status === 'analyzing'
    || status === 'summarizing'
  );
}

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

export function buildPlanControlRequestId(planId: string, timestamp: string): string {
  return `control_${timestamp}_${planId}`;
}

function parsePlanControlRequestRecord(value: unknown): PlanControlRequestRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const planId = String(value.plan_id ?? '').trim();
  const action = value.action;
  const timestamp = String(value.timestamp ?? '').trim();
  if (!planId || !timestamp) {
    return null;
  }
  if (action !== 'launch' && action !== 'pause' && action !== 'modify' && action !== 'terminate') {
    return null;
  }
  const nextValue: PlanControlRequestRecord = {
    plan_id: planId,
    action,
    timestamp,
  };
  if (typeof value.user_authored_text === 'string') {
    nextValue.user_authored_text = value.user_authored_text;
  }
  return nextValue;
}

export function shouldEnsureRunProcessForPlanControl(
  plan: PlanRecord,
  action: PlanControlAction
): boolean {
  const status = typeof plan.status === 'string' ? plan.status : 'pending';
  if (!isNonterminalPlanStatus(status)) {
    return false;
  }
  return action === 'launch' || action === 'pause' || action === 'terminate' || action === 'modify';
}

export function applyPendingPlanControlPreviews(args: {
  state: Record<string, unknown>;
  controlPayloads: unknown[];
}): Record<string, unknown> {
  const { state, controlPayloads } = args;
  const nextState: Record<string, unknown> = { ...state };
  const frontier = Array.isArray(nextState.frontier) ? nextState.frontier : null;
  const plans = frontier ?? (Array.isArray(nextState.plans) ? nextState.plans : null);
  if (!plans) {
    return nextState;
  }

  const appliedControlIds = new Set<string>();
  const executionControlState = isRecord(nextState.execution_control_state)
    ? nextState.execution_control_state
    : null;
  if (Array.isArray(executionControlState?.applied_control_ids)) {
    for (const rawControlId of executionControlState.applied_control_ids) {
      const controlId = String(rawControlId ?? '').trim();
      if (controlId) {
        appliedControlIds.add(controlId);
      }
    }
  }

  const nextPlans = plans.map((rawPlan) => {
    const normalizedPlan = applyPlanControlPreviewToPlanRecord({
      plan: rawPlan as PlanRecord,
      action: 'launch',
    });
    normalizedPlan.status = typeof (rawPlan as PlanRecord).status === 'string'
      ? String((rawPlan as PlanRecord).status)
      : 'pending';
    normalizedPlan.control_state = typeof (rawPlan as PlanRecord).control_state === 'string'
      ? String((rawPlan as PlanRecord).control_state)
      : 'none';
    normalizedPlan.launch_requested = Boolean((rawPlan as PlanRecord).launch_requested);
    normalizedPlan.pending_modified_text =
      typeof (rawPlan as PlanRecord).pending_modified_text === 'string'
        ? String((rawPlan as PlanRecord).pending_modified_text)
        : null;
    return normalizedPlan;
  });

  const planIndexById = new Map<string, number>();
  nextPlans.forEach((plan, index) => {
    const planId = String(plan.plan_id ?? '').trim();
    if (planId) {
      planIndexById.set(planId, index);
    }
    for (const rawControlId of Array.isArray(plan.linked_control_ids) ? plan.linked_control_ids : []) {
      const controlId = String(rawControlId ?? '').trim();
      if (controlId) {
        appliedControlIds.add(controlId);
      }
    }
  });

  for (const rawPayload of controlPayloads) {
    const request = parsePlanControlRequestRecord(rawPayload);
    if (!request) {
      continue;
    }
    const controlId = buildPlanControlRequestId(request.plan_id, request.timestamp);
    if (appliedControlIds.has(controlId)) {
      continue;
    }
    const planIndex = planIndexById.get(request.plan_id);
    if (typeof planIndex !== 'number') {
      continue;
    }
    const existingPlan = nextPlans[planIndex];
    const nextPlan = applyPlanControlPreviewToPlanRecord({
      plan: existingPlan,
      action: request.action,
      userAuthoredText: request.user_authored_text,
    });
    const linkedControlIds = Array.isArray(existingPlan.linked_control_ids)
      ? existingPlan.linked_control_ids.map((item) => String(item))
      : [];
    if (!linkedControlIds.includes(controlId)) {
      linkedControlIds.push(controlId);
    }
    nextPlan.linked_control_ids = linkedControlIds;
    nextPlans[planIndex] = nextPlan;
    appliedControlIds.add(controlId);
  }

  if (frontier) {
    nextState.frontier = nextPlans;
  }
  if (Array.isArray(nextState.plans)) {
    nextState.plans = nextPlans;
  }
  return nextState;
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
