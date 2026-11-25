import { expect, it } from 'vitest';
import { packageName, PatientMessenger } from './index.js';

it('exports the public interface', () => {
  expect(packageName).toBe('@scheduler/integrations-messaging');
  expect(typeof PatientMessenger).toBe('function');
});
