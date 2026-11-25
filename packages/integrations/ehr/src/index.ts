/** EHR connectors and write-back. */
export const packageName = '@scheduler/integrations-ehr';

export * from './types.js';
export * from './capabilities.js';
export * from './result.js';
export * from './connector.js';
export * from './locations.js';
export * from './guard.js';
export * from './ports.js';
export { InMemoryEhrConnector, type FakeEhrLocationData } from './fake/in-memory-connector.js';
export { loadEhrConfig, REDOX_API_BASE_URL, type EhrConfig, type EhrProvider } from './redox/config.js';
export { RedoxTransport, type RedoxTransportOptions } from './redox/transport.js';
export {
  RedoxEhrConnector,
  REDOX_OPERATIONS,
  type RedoxEhrConnectorOptions,
  type RedoxOperation,
  type RedoxOperationStatus,
} from './redox/connector.js';
