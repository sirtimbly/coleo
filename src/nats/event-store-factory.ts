import type { JetStreamClient, JetStreamManager } from 'nats';
import type { IEventStore } from './jetstream-types';
import type { EventStore as EventStoreClass } from './jetstream';

let _eventStore: IEventStore | undefined;

function getDefaultStore(): IEventStore {
  if (!_eventStore) {
    const { EventStore } = require('./jetstream') as typeof import('./jetstream');
    _eventStore = new EventStore();
  }
  return _eventStore!;
}

export const eventStore: IEventStore = new Proxy({} as IEventStore, {
  get(_target, prop) {
    const store = getDefaultStore();
    const value = store[prop as keyof IEventStore];
    if (typeof value === 'function') {
      return value.bind(store);
    }
    return value;
  },
});

export function setEventStore(store: IEventStore): void {
  _eventStore = store;
}

export function resetEventStore(): void {
  const { EventStore } = require('./jetstream') as typeof import('./jetstream');
  _eventStore = new EventStore();
}

export async function initializeJetStreamEventStore(
  js: JetStreamClient,
  jsm: JetStreamManager
): Promise<void> {
  const { EventStore } = require('./jetstream') as typeof import('./jetstream');
  if (!(_eventStore instanceof EventStore)) {
    _eventStore = new EventStore();
  }
  await (_eventStore as EventStoreClass).initialize(js, jsm);
}

export { InMemoryEventStore } from './in-memory-event-store';
export { createTestEventStore } from './in-memory-event-store';
