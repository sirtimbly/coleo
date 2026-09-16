import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { VersionStatus } from '../src/components/VersionStatus';
import { RUNTIME_VERSION } from '../../version';

describe('dashboard component versions', () => {
  it('shows each host and incompatible schema warnings', () => {
    const html = renderToStaticMarkup(<VersionStatus loading={false} stale={false} versions={{
      api: RUNTIME_VERSION,
      agentDiscoveryAvailable: true,
      agents: [{ ...RUNTIME_VERSION, agentId: 'host-1', hostname: 'reef', natsSchemaVersion: 999 }],
    }} />);
    expect(html).toContain('Web app');
    expect(html).toContain('API server');
    expect(html).toContain('reef (host-1)');
    expect(html).toContain('Incompatible releases or NATS schemas');
  });

  it('warns about old APIs, unavailable discovery, and stale observations', () => {
    const html = renderToStaticMarkup(<VersionStatus loading={false} stale={true} apiVersion={RUNTIME_VERSION.version} />);
    expect(html).toContain('Stale report');
    expect(html).toContain('fleet compatibility cannot be verified');
    expect(html).toContain('do not report valid version metadata');
  });

  it('does not issue mismatch warnings while the initial request is loading', () => {
    const html = renderToStaticMarkup(<VersionStatus loading={true} stale={false} />);
    expect(html).toContain('Checking');
    expect(html).not.toContain('Upgrade them');
  });
});
