export const GATE_A = {
  /** Corrections must be strictly under this rate. */
  maxCorrectionRate: 0.02,
  /** Scheduler minutes per case must fall by at least this share versus baseline. */
  minSchedulerTimeReduction: 0.3,
} as const;

export interface GateAResult {
  correctionRatePct: number | null;
  correctionPass: boolean | null;
  baselineMinutes: number | null;
  currentMinutes: number | null;
  /** Relative change, e.g. -0.357. */
  schedulerTimeChange: number | null;
  /** Whole percent for display, e.g. -36. */
  schedulerTimeChangePct: number | null;
  schedulerTimePass: boolean | null;
  pass: boolean | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function evaluateGateA(input: {
  edits: number;
  rejections: number;
  agentActions: number;
  baselineMinutes: number | null;
  currentMinutes: number | null;
}): GateAResult {
  const { edits, rejections, agentActions, baselineMinutes, currentMinutes } = input;
  // Integer comparison avoids float error: exactly 2.0% is NOT under 2%.
  const correctionPass = agentActions === 0 ? null : (edits + rejections) * 100 < agentActions * 2;
  const correctionRatePct = agentActions === 0 ? null : round1(((edits + rejections) / agentActions) * 100);
  let change: number | null = null;
  if (baselineMinutes !== null && baselineMinutes > 0 && currentMinutes !== null) {
    change = (currentMinutes - baselineMinutes) / baselineMinutes;
  }
  const schedulerTimePass = change === null ? null : change <= -GATE_A.minSchedulerTimeReduction + 1e-12;
  return {
    correctionRatePct,
    correctionPass,
    baselineMinutes,
    currentMinutes,
    schedulerTimeChange: change,
    schedulerTimeChangePct: change === null ? null : Math.round(change * 100),
    schedulerTimePass,
    pass: correctionPass === null || schedulerTimePass === null ? null : correctionPass && schedulerTimePass,
  };
}
