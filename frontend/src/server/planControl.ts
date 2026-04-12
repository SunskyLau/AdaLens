export type PlanControlAction =
  | 'start'
  | 'pause'
  | 'resume'
  | 'terminate';

export type PlanRecord = Record<string, unknown> & {
  plan_id?: string;
  status?: string;
  control_state?: string;
  resume_phase?: string | null;
  checkpoint_path?: string | null;
};

export function applyPlanControlToPlanRecord(
  plan: PlanRecord,
  action: PlanControlAction
): { allowed: boolean; changed: boolean } {
  const status = typeof plan.status === 'string' ? plan.status : 'pending';

  if (action === 'start') {
    return { allowed: status === 'pending', changed: false };
  }

  if (action === 'pause') {
    return {
      allowed: status === 'pending' || status === 'analyzing' || status === 'summarizing',
      changed: false,
    };
  }

  if (action === 'resume') {
    return { allowed: status === 'paused' || status === 'pending', changed: false };
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

export function buildPlanControlResponse(args: {
  plan: PlanRecord;
  action: PlanControlAction;
  persistedRunStatus: string;
}): {
  plan: PlanRecord;
  runStatus: string;
  emitPlanStatusChanged: boolean;
} {
  return {
    plan: args.plan,
    runStatus: args.persistedRunStatus,
    emitPlanStatusChanged: false,
  };
}
