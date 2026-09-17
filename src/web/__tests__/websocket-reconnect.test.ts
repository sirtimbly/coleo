import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { SharedWebSocketTransport } from '../src/hooks/useWebSocket';
import { api } from '../src/lib/api';

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  constructor() { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  auth(success: boolean) { this.onmessage?.({ data: JSON.stringify({ type: 'auth', success }) }); }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
let transport: SharedWebSocketTransport;
let keySpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  FakeSocket.instances = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { protocol: 'https:', host: 'test.coleo.app' } } });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket });
  keySpy = spyOn(api, 'getApiKey').mockReturnValue('test-key');
  transport = new SharedWebSocketTransport();
});
afterEach(() => {
  transport.disconnect();
  keySpy.mockRestore();
  for (const [name, descriptor] of [['window', originalWindow], ['WebSocket', originalSocket]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

for (const initialState of ['connecting', 'rejected-auth'] as const) {
  test(`manual reconnect replaces a ${initialState} socket and restores subscriptions`, () => {
    const received: unknown[] = [];
    const unsubscribe = transport.addSubscriber({
      channels: new Set(['arms']),
      onMessageRef: { current: (message) => received.push(message) },
    });
    const oldSocket = FakeSocket.instances[0]!;
    if (initialState === 'rejected-auth') { oldSocket.open(); oldSocket.auth(false); }
    transport.connect();
    expect(FakeSocket.instances).toHaveLength(1);

    transport.reconnect();
    expect(oldSocket.closed).toBe(true);
    expect(oldSocket.onopen).toBeNull();
    expect(oldSocket.onmessage).toBeNull();
    expect(oldSocket.onclose).toBeNull();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(transport.getSnapshot()).toEqual({ connected: false, authenticated: false });
    const replacement = FakeSocket.instances[1]!;
    replacement.open();
    expect(replacement.sent).toContainEqual({ type: 'auth', apiKey: 'test-key' });
    replacement.auth(true);
    expect(transport.getSnapshot()).toEqual({ connected: true, authenticated: true });
    expect(replacement.sent).toContainEqual({ type: 'subscribe', channel: 'arms' });
    replacement.onmessage?.({ data: JSON.stringify({ type: 'event', channel: 'arms' }) });
    expect(received).toHaveLength(1);
    unsubscribe();
  });
}
