export const BASELINE_METRICS = [
  'scheduler_minutes_per_case',
  'late_cancellations_per_week',
  'days_order_to_auth_decision',
  'auth_first_pass_rate',
  'patient_calls_per_case',
  'auth_denials_per_week',
] as const;
export type BaselineMetric = (typeof BASELINE_METRICS)[number];

export interface BaselineRow {
  practiceId: string;
  metric: BaselineMetric;
  value: number;
  source: string;
}
export interface BaselineImportResult {
  rows: BaselineRow[];
  errors: string[];
}

const HEADER = ['practice_id', 'metric', 'value', 'source'];

function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Validates the time-and-motion / cancellation-log baseline CSV. Errors never echo cell contents. */
export function importBaseline(csv: string): BaselineImportResult {
  const errors: string[] = [];
  const rows: BaselineRow[] = [];
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { rows, errors: ['file is empty'] };
  const header = splitLine(lines[0] ?? '');
  if (header.join(',') !== HEADER.join(',')) {
    return { rows, errors: [`header must be exactly: ${HEADER.join(',')}`] };
  }
  const seen = new Set<string>();
  lines.slice(1).forEach((line, i) => {
    const n = i + 2;
    const cells = splitLine(line);
    if (cells.length !== HEADER.length) {
      errors.push(`line ${n}: expected 4 columns`);
      return;
    }
    const [practiceId = '', metric = '', rawValue = '', source = ''] = cells;
    let ok = true;
    if (!practiceId) {
      errors.push(`line ${n}: practice_id is required`);
      ok = false;
    }
    if (!(BASELINE_METRICS as readonly string[]).includes(metric)) {
      errors.push(`line ${n}: unknown metric`);
      ok = false;
    }
    const value = Number(rawValue);
    if (rawValue === '' || !Number.isFinite(value) || value < 0) {
      errors.push(`line ${n}: value must be a non-negative number`);
      ok = false;
    } else if (metric === 'auth_first_pass_rate' && value > 1) {
      errors.push(`line ${n}: auth_first_pass_rate must be between 0 and 1`);
      ok = false;
    }
    if (!source) {
      errors.push(`line ${n}: source is required`);
      ok = false;
    }
    const key = `${practiceId}|${metric}`;
    if (seen.has(key)) {
      errors.push(`line ${n}: duplicate practice and metric`);
      ok = false;
    }
    if (ok) seen.add(key);
    if (ok) rows.push({ practiceId, metric: metric as BaselineMetric, value, source });
  });
  return { rows, errors };
}

export function baselineFor(rows: BaselineRow[], practiceId: string, metric: BaselineMetric): number | null {
  return rows.find((r) => r.practiceId === practiceId && r.metric === metric)?.value ?? null;
}
