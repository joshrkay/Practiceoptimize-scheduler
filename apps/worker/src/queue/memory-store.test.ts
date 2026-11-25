import { InMemoryQueueStore } from './memory-store.js';
import { queueStoreContract } from './testing/store-contract.js';

queueStoreContract('InMemoryQueueStore', async () => new InMemoryQueueStore());
