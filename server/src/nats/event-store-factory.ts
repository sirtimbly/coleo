import type { JetStreamClient, JetStreamManager } from 'nats';
import type { IEventStore } from './jetstream-types';
import { EventStore } from './event-store';

let _eventStore: IEventStore | undefined;

function getDefaultStore(): IEventStore {
  if (!_eventStore) {
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
  _eventStore = new EventStore();
}

export async function initializeJetStreamEventStore(
  js: JetStreamClient,
  jsm: JetStreamManager
): Promise<void> {
  if (!(_eventStore instanceof EventStore)) {
    _eventStore = new EventStore();
  }
  await (_eventStore as EventStore).initialize(js, jsm);
}

export { InMemoryEventStore } from './in-memory-event-store';
export { createTestEventStore } from './in-memory-event-store';
