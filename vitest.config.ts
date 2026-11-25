import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // apps/web sets jsx to preserve for Next.js; tests need it compiled.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@scheduler/case-model': src('./packages/case-model/src/index.ts'),
      '@scheduler/agent': src('./packages/agent/src/index.ts'),
      '@scheduler/tenancy': src('./packages/tenancy/src/index.ts'),
      '@scheduler/db': src('./packages/db/src/index.ts'),
      '@scheduler/audit': src('./packages/audit/src/index.ts'),
      '@scheduler/fhir': src('./packages/fhir/src/index.ts'),
      '@scheduler/integrations-availity': src('./packages/integrations/availity/src/index.ts'),
      '@scheduler/integrations-ehr': src('./packages/integrations/ehr/src/index.ts'),
      '@scheduler/integrations-esign': src('./packages/integrations/esign/src/index.ts'),
      '@scheduler/integrations-fax': src('./packages/integrations/fax/src/index.ts'),
      '@scheduler/integrations-portals': src('./packages/integrations/portals/src/index.ts'),
    },
  },
  test: {
    include: ['{apps,packages,evals,tests,infra}/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/cdk.out/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['{apps,packages,evals}/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        '**/*.config.{ts,mjs}',
        '**/node_modules/**',
        '**/.next/**',
        'evals/run.ts',
      ],
      thresholds: { lines: 90 },
    },
  },
});
