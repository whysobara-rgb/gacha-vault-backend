import { releaseIdentity } from './release-identity';
import { AppService } from '../app.service';

const commit = 'a'.repeat(40);
describe('public release identity', () => {
  it('identifies a Render revision without echoing other environment data', () => {
    expect(releaseIdentity({ RENDER_GIT_COMMIT: commit, DB_PASSWORD: 'never-output' })).toEqual({
      contract: 'RELEASE_IDENTITY_V1', commit, source: 'render', consistent: true,
    });
  });
  it('allows an explicit non-Render revision', () => {
    expect(releaseIdentity({ APP_COMMIT_SHA: commit }).source).toBe('configured');
  });
  it('does not invent a revision for unknown builds', () => {
    expect(releaseIdentity({})).toMatchObject({ commit: null, consistent: false });
  });
  it.each(['', 'secret', 'a'.repeat(7), 'A'.repeat(40), 'a'.repeat(40) + '\n'])('rejects malformed revision %p', (value) => {
    expect(releaseIdentity({ RENDER_GIT_COMMIT: value, APP_COMMIT_SHA: commit })).toMatchObject({ source: 'invalid', commit: null });
  });
  it('rejects contradictory revision sources', () => {
    expect(releaseIdentity({ RENDER_GIT_COMMIT: commit, APP_COMMIT_SHA: 'b'.repeat(40) })).toMatchObject({ source: 'conflict', consistent: false });
  });
  it('accepts matching sources', () => {
    expect(releaseIdentity({ RENDER_GIT_COMMIT: commit, APP_COMMIT_SHA: commit }).consistent).toBe(true);
  });
  it('exposes the same startup revision in liveness and readiness without writes', async () => {
    const old = process.env;
    try {
      process.env = { ...old, RENDER_GIT_COMMIT: commit };
      delete process.env.APP_COMMIT_SHA;
      const query = jest.fn().mockResolvedValue([{ name: 'Example1700000000000' }]);
      const service = new AppService({ isInitialized: true, migrations: [{ name: 'Example1700000000000' }], query } as any);
      process.env.RENDER_GIT_COMMIT = 'b'.repeat(40);
      expect(service.getHealth().release.commit).toBe(commit);
      expect((await service.getReadiness()).release.commit).toBe(commit);
      expect(query).toHaveBeenCalledWith('SELECT name FROM migrations');
      expect(query).toHaveBeenCalledTimes(1);
    } finally { process.env = old; }
  });
});
