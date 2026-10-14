export type ReleaseIdentity = {
  contract: 'RELEASE_IDENTITY_V1';
  commit: string | null;
  source: 'render' | 'configured' | 'unconfigured' | 'invalid' | 'conflict';
  consistent: boolean;
};

/** Public revision metadata only; not a signature or a commercial launch approval. */
export function releaseIdentity(env: NodeJS.ProcessEnv = process.env): ReleaseIdentity {
  const render = env.RENDER_GIT_COMMIT;
  const configured = env.APP_COMMIT_SHA;
  const base = { contract: 'RELEASE_IDENTITY_V1' as const };
  const valid = (s: string) => s.length === 40 && /^[a-f0-9]{40}$/.test(s);
  if ((render !== undefined && !valid(render)) || (configured !== undefined && !valid(configured)))
    return { ...base, commit: null, source: 'invalid', consistent: false };
  if (render && configured && render !== configured)
    return { ...base, commit: null, source: 'conflict', consistent: false };
  if (render) return { ...base, commit: render, source: 'render', consistent: true };
  if (configured) return { ...base, commit: configured, source: 'configured', consistent: true };
  return { ...base, commit: null, source: 'unconfigured', consistent: false };
}
