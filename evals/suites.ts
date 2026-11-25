/** One evaluation suite: a named set of checks over agent behavior. */
export interface EvalSuite {
  name: string;
  description: string;
  run: () => Promise<EvalResult>;
}

export interface EvalResult {
  passed: number;
  failed: number;
  failures: string[];
}

/** Registry of suites. Agent behavior issues add their suite here. */
export const suites: EvalSuite[] = [
  {
    name: 'smoke',
    description: 'Proves the evaluation runner works end to end.',
    run: async () => ({ passed: 1, failed: 0, failures: [] }),
  },
];

/** Runs the named suites, or every suite when none is named. */
export async function runSuites(names: string[], registry: EvalSuite[] = suites) {
  const unknown = names.filter((name) => !registry.some((suite) => suite.name === name));
  if (unknown.length > 0) {
    throw new Error(`Unknown eval suite: ${unknown.join(', ')}`);
  }
  const selected = names.length > 0 ? registry.filter((suite) => names.includes(suite.name)) : registry;
  const results = [];
  for (const suite of selected) {
    results.push({ name: suite.name, ...(await suite.run()) });
  }
  return results;
}
