import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, JWTVerifyGetKey, jwtVerify } from 'jose';
import { AuthProvider } from '../../../entities';

/** What a provider vouches for after its token has been verified. */
export interface SocialIdentity {
  providerId: string;
  email: string | null;
  emailVerified: boolean;
  nickname: string | null;
}

export class SocialTokenError extends Error {}
export class ProviderNotConfiguredError extends Error {}
export class ProviderUnavailableError extends Error {}

type FetchFn = typeof fetch;

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const APPLE_ISSUER = 'https://appleid.apple.com';

/**
 * Verifies a social login token with its provider and returns the identity
 * it proves. The client never gets to assert a providerId or email itself.
 *
 *   KAKAO  access token → /v1/user/access_token_info must report our
 *          KAKAO_APP_ID (rejects tokens issued to other apps), then
 *          /v2/user/me for the profile.
 *   NAVER  access token → /v1/nid/me.
 *   GOOGLE ID token (JWT) → signature via Google's JWKS, iss, exp and
 *          aud ∈ GOOGLE_CLIENT_IDS.
 *   APPLE  identity token (JWT) → signature via Apple's JWKS, iss, exp and
 *          aud ∈ APPLE_CLIENT_IDS.
 *
 * A provider without its config is reported as not configured instead of
 * being accepted unverified.
 */
@Injectable()
export class SocialVerifier {
  private readonly jwks = new Map<AuthProvider, JWTVerifyGetKey>();
  private fetchFn: FetchFn = (input, init) => fetch(input, init);

  constructor(private readonly config: ConfigService) {}

  /** Test hooks: swap the HTTP client and the JWT key resolvers. */
  useFetch(fetchFn: FetchFn) {
    this.fetchFn = fetchFn;
  }
  useKeys(provider: AuthProvider, keys: JWTVerifyGetKey) {
    this.jwks.set(provider, keys);
  }

  configuredProviders(): AuthProvider[] {
    const providers: AuthProvider[] = [];
    if (this.setting('KAKAO_APP_ID')) providers.push(AuthProvider.KAKAO);
    if (this.setting('NAVER_CLIENT_ID')) providers.push(AuthProvider.NAVER);
    if (this.list('GOOGLE_CLIENT_IDS').length) {
      providers.push(AuthProvider.GOOGLE);
    }
    if (this.list('APPLE_CLIENT_IDS').length) {
      providers.push(AuthProvider.APPLE);
    }
    return providers;
  }

  async verify(provider: AuthProvider, token: string): Promise<SocialIdentity> {
    if (!this.configuredProviders().includes(provider)) {
      throw new ProviderNotConfiguredError(provider);
    }
    switch (provider) {
      case AuthProvider.KAKAO:
        return this.verifyKakao(token);
      case AuthProvider.NAVER:
        return this.verifyNaver(token);
      case AuthProvider.GOOGLE:
        return this.verifyIdToken(provider, token, {
          issuer: GOOGLE_ISSUERS,
          audience: this.list('GOOGLE_CLIENT_IDS'),
          jwksUri:
            this.setting('GOOGLE_JWKS_URI') ??
            'https://www.googleapis.com/oauth2/v3/certs',
        });
      case AuthProvider.APPLE:
        return this.verifyIdToken(provider, token, {
          issuer: [APPLE_ISSUER],
          audience: this.list('APPLE_CLIENT_IDS'),
          jwksUri:
            this.setting('APPLE_JWKS_URI') ??
            'https://appleid.apple.com/auth/keys',
        });
      default:
        throw new SocialTokenError(`Unsupported provider ${provider}`);
    }
  }

  private async verifyKakao(token: string): Promise<SocialIdentity> {
    const info = await this.getJson(
      'https://kapi.kakao.com/v1/user/access_token_info',
      token,
    );
    if (String(info.app_id) !== this.setting('KAKAO_APP_ID')) {
      throw new SocialTokenError('Kakao token was issued to another app');
    }
    const me = await this.getJson('https://kapi.kakao.com/v2/user/me', token);
    const account = me.kakao_account ?? {};
    const emailUsable = account.is_email_valid !== false;
    return {
      providerId: String(me.id),
      email: emailUsable ? (account.email ?? null) : null,
      emailVerified: account.is_email_verified === true,
      nickname: account.profile?.nickname ?? null,
    };
  }

  private async verifyNaver(token: string): Promise<SocialIdentity> {
    const me = await this.getJson('https://openapi.naver.com/v1/nid/me', token);
    if (me.resultcode !== '00' || !me.response?.id) {
      throw new SocialTokenError('Naver token rejected');
    }
    return {
      providerId: String(me.response.id),
      email: me.response.email ?? null,
      emailVerified: !!me.response.email,
      nickname: me.response.nickname ?? null,
    };
  }

  private async verifyIdToken(
    provider: AuthProvider,
    token: string,
    opts: { issuer: string[]; audience: string[]; jwksUri: string },
  ): Promise<SocialIdentity> {
    let keys = this.jwks.get(provider);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(opts.jwksUri));
      this.jwks.set(provider, keys);
    }
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: opts.issuer,
        audience: opts.audience,
      });
      if (!payload.sub) throw new SocialTokenError('Token has no subject');
      const email = typeof payload.email === 'string' ? payload.email : null;
      // Apple sends email_verified as the string "true".
      const verified =
        payload.email_verified === true || payload.email_verified === 'true';
      return {
        providerId: payload.sub,
        email,
        emailVerified: !!email && verified,
        nickname: typeof payload.name === 'string' ? payload.name : null,
      };
    } catch (err) {
      if (err instanceof SocialTokenError) throw err;
      throw new SocialTokenError(`${provider} token rejected`);
    }
  }

  private async getJson(url: string, token: string): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new ProviderUnavailableError(url);
    }
    if (res.status >= 500) throw new ProviderUnavailableError(url);
    if (!res.ok) throw new SocialTokenError('Provider rejected token');
    return res.json();
  }

  private setting(key: string): string | undefined {
    const value = this.config.get<string>(key)?.trim();
    return value ? value : undefined;
  }

  private list(key: string): string[] {
    return (this.setting(key) ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
}
