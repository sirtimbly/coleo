import { expect, test } from 'bun:test';
import { Brain } from '../brain';

test('runCycles polls exactly the requested number of times', async () => {
  const brain = Object.create(Brain.prototype) as Brain;
  const internals = brain as unknown as {
    state: { status: string; startedAt: string | null };
    notifyObservatory: (event: string) => Promise<void>;
    poll: () => Promise<void>;
    saveState: () => Promise<void>;
  };
  const events: string[] = [];
  let polls = 0;

  internals.state = { status: 'idle', startedAt: null };
  internals.notifyObservatory = async (event) => {
    events.push(event);
  };
  internals.poll = async () => {
    polls++;
  };
  internals.saveState = async () => {};

  await brain.runCycles(3, 0);

  expect(polls).toBe(3);
  expect(events).toEqual(['started', 'stopped']);
  expect(internals.state.status).toBe('stopped');
});
