import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
const { assess, probe, configuration } = require('../../tools/release/deployment-probe.cjs');
const sha = 'a'.repeat(40);
const ready = () => ({ statusCode: 10000, message: 'success', data: {
  service: 'gacha-vault-api', status: 'ready', database: 'connected', schema: 'current',
  release: { contract: 'RELEASE_IDENTITY_V1', commit: sha, source: 'render', consistent: true },
} });
describe('read-only deployed revision probe', () => {
  it('passes ready expected revisions without approving a commercial launch', () => {
    expect(assess(200, ready(), sha)).toMatchObject({ deploymentVerified: true, businessLaunchApproved: false });
  });
  it('rejects liveness-only and wrong revisions', () => {
    const body = ready(); body.data.status = 'ok';
    expect(() => assess(200, body, sha)).toThrow('DATABASE_NOT_READY');
    expect(() => assess(200, ready(), 'b'.repeat(40))).toThrow('REVISION_MISMATCH');
  });
  it('rejects old servers without identity metadata', () => {
    const body: any = ready(); delete body.data.release;
    expect(() => assess(200, body, sha)).toThrow('REVISION_UNVERIFIED');
  });
  it('rejects missing revision, unsafe origin and non-test plain HTTP before requesting', async () => {
    for (const env of [ {}, { PROBE_ORIGIN: 'https://host.invalid', PROBE_EXPECTED_COMMIT: 'bad' },
      { PROBE_ORIGIN: 'https://user:secret@host.invalid', PROBE_EXPECTED_COMMIT: sha },
      { PROBE_ORIGIN: 'https://host.invalid/path', PROBE_EXPECTED_COMMIT: sha },
      { PROBE_ORIGIN: 'http://127.0.0.1', PROBE_EXPECTED_COMMIT: sha },
    ]) {
      const request = jest.fn();
      expect((await probe(env, request)).status).toBe('BLOCKED');
      expect(request).not.toHaveBeenCalled();
    }
  });
  it('allows only explicit local HTTP test origins', () => {
    expect(configuration({ NODE_ENV: 'test', ALLOW_LOCAL_PROBE: 'true', PROBE_ORIGIN: 'http://127.0.0.1:3000', PROBE_EXPECTED_COMMIT: sha }).origin).toBe('http://127.0.0.1:3000');
  });
  it('sanitizes network and provider errors', async () => {
    const result = await probe({ PROBE_ORIGIN: 'https://host.invalid', PROBE_EXPECTED_COMMIT: sha }, async () => { throw new Error('secret-must-not-appear'); });
    expect(result.code).toBe('TRANSPORT_FAILED');
    expect(JSON.stringify(result)).not.toContain('secret-must-not-appear');
  });
  it('checks a real local HTTP server, refuses redirects and bounds response bytes', async () => {
    let mode = 'ready'; const methods: string[] = []; const auth: any[] = [];
    const server: Server = createServer((req, res) => {
      methods.push(req.method!); auth.push(req.headers.authorization);
      if (mode === 'redirect') { res.writeHead(302, { location: '/health/ready' }); res.end(); return; }
      res.setHeader('content-type', 'application/json');
      if (mode === 'large') { res.end('x'.repeat(33000)); return; }
      if (mode === 'broken') { res.end('{'); return; }
      if (mode === 'unready') { res.writeHead(503); res.end('{}'); return; }
      res.end(JSON.stringify(ready()));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = { NODE_ENV: 'test', ALLOW_LOCAL_PROBE: 'true', PROBE_ORIGIN: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, PROBE_EXPECTED_COMMIT: sha };
    try {
      expect((await probe(env)).deploymentVerified).toBe(true);
      mode = 'redirect'; expect((await probe(env)).code).toBe('TRANSPORT_FAILED');
      mode = 'large'; expect((await probe(env)).code).toBe('RESPONSE_TOO_LARGE');
      mode = 'broken'; expect((await probe(env)).code).toBe('INVALID_JSON');
      mode = 'unready'; expect((await probe(env)).code).toBe('READINESS_HTTP_FAILED');
      expect(methods.every(m => m === 'GET')).toBe(true);
      expect(auth.every(a => a === undefined)).toBe(true);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  }, 15000);
});
