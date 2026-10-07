import { ConfigService } from '@nestjs/config';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  JWTVerifyGetKey,
  KeyLike,
  SignJWT,
} from 'jose';
import { AuthProvider } from '../../../entities';
import {
  ProviderNotConfiguredError,
  ProviderUnavailableError,
  SocialTokenError,
  SocialVerifier,
} from './social-verifier';

const config = {
  KAKAO_APP_ID: '1234',
  NAVER_CLIENT_ID: 'naver-client',
  GOOGLE_CLIENT_IDS: 'ios-client, android-client',
  APPLE_CLIENT_IDS: 'com.gachavault.gacha',
};

function verifierWith(settings: Record<string, string> = config) {
  return new SocialVerifier(new ConfigService(settings));
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** fetch stub answering by URL. */
function fakeFetch(routes: Record<string, () => Response>) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const route = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!route) throw new Error(`unexpected ${url}`);
    return routes[route]();
  }) as typeof fetch;
}

describe('SocialVerifier', () => {
  let privateKey: KeyLike;
  let otherKey: KeyLike;
  let keys: JWTVerifyGetKey;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    otherKey = (await generateKeyPair('RS256')).privateKey;
    const jwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: 'k1',
      alg: 'RS256',
    };
    keys = createLocalJWKSet({ keys: [jwk] });
  });

  const idToken = (
    claims: Record<string, unknown>,
    opts: {
      issuer: string;
      audience: string;
      key?: KeyLike;
      expiresIn?: string;
    },
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(opts.issuer)
      .setAudience(opts.audience)
      .setSubject(String(claims.sub ?? 'google-sub-1'))
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? '10m')
      .sign(opts.key ?? privateKey);

  it('lists only providers that have server config', () => {
    expect(verifierWith().configuredProviders()).toEqual([
      AuthProvider.KAKAO,
      AuthProvider.NAVER,
      AuthProvider.GOOGLE,
      AuthProvider.APPLE,
    ]);
    expect(verifierWith({ KAKAO_APP_ID: ' ' }).configuredProviders()).toEqual(
      [],
    );
  });

  it('refuses an unconfigured provider instead of trusting the client', async () => {
    await expect(
      verifierWith({}).verify(AuthProvider.KAKAO, 'token-value'),
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  describe('Google ID token', () => {
    const google = () => {
      const v = verifierWith();
      v.useKeys(AuthProvider.GOOGLE, keys);
      return v;
    };

    it('accepts a valid token for one of our client ids', async () => {
      const token = await idToken(
        {
          sub: 'g-1',
          email: 'a@gmail.com',
          email_verified: true,
          name: '구글유저',
        },
        { issuer: 'https://accounts.google.com', audience: 'android-client' },
      );
      await expect(
        google().verify(AuthProvider.GOOGLE, token),
      ).resolves.toEqual({
        providerId: 'g-1',
        email: 'a@gmail.com',
        emailVerified: true,
        nickname: '구글유저',
      });
    });

    it.each([
      ['another app', { audience: 'someone-elses-client' }],
      ['wrong issuer', { issuer: 'https://evil.example.com' }],
      ['expired', { expiresIn: '-1m' }],
      ['forged signature', { key: 'other' }],
    ])('rejects a token from %s', async (_, override: any) => {
      const token = await idToken(
        { sub: 'g-1' },
        {
          issuer: override.issuer ?? 'https://accounts.google.com',
          audience: override.audience ?? 'ios-client',
          expiresIn: override.expiresIn,
          key: override.key === 'other' ? otherKey : undefined,
        },
      );
      await expect(
        google().verify(AuthProvider.GOOGLE, token),
      ).rejects.toBeInstanceOf(SocialTokenError);
    });
  });

  it('reads Apple email_verified sent as a string', async () => {
    const v = verifierWith();
    v.useKeys(AuthProvider.APPLE, keys);
    const token = await idToken(
      {
        sub: 'apple-1',
        email: 'x@privaterelay.appleid.com',
        email_verified: 'true',
      },
      { issuer: 'https://appleid.apple.com', audience: 'com.gachavault.gacha' },
    );
    await expect(v.verify(AuthProvider.APPLE, token)).resolves.toMatchObject({
      providerId: 'apple-1',
      emailVerified: true,
      nickname: null,
    });
  });

  describe('Kakao access token', () => {
    const kakao = (routes: Record<string, () => Response>) => {
      const v = verifierWith();
      v.useFetch(fakeFetch(routes));
      return v;
    };
    const me = () =>
      jsonResponse(200, {
        id: 98765,
        kakao_account: {
          email: 'k@kakao.com',
          is_email_valid: true,
          is_email_verified: true,
          profile: { nickname: '카카오' },
        },
      });

    it('accepts a token issued to our app', async () => {
      const v = kakao({
        'https://kapi.kakao.com/v1/user/access_token_info': () =>
          jsonResponse(200, { id: 98765, app_id: 1234 }),
        'https://kapi.kakao.com/v2/user/me': me,
      });
      await expect(
        v.verify(AuthProvider.KAKAO, 'kakao-token'),
      ).resolves.toEqual({
        providerId: '98765',
        email: 'k@kakao.com',
        emailVerified: true,
        nickname: '카카오',
      });
    });

    it('rejects a token issued to a different app', async () => {
      const v = kakao({
        'https://kapi.kakao.com/v1/user/access_token_info': () =>
          jsonResponse(200, { id: 98765, app_id: 9999 }),
        'https://kapi.kakao.com/v2/user/me': me,
      });
      await expect(
        v.verify(AuthProvider.KAKAO, 'kakao-token'),
      ).rejects.toBeInstanceOf(SocialTokenError);
    });

    it('rejects an invalid token and reports outages separately', async () => {
      const invalid = kakao({
        'https://kapi.kakao.com/v1/user/access_token_info': () =>
          jsonResponse(401, { code: -401 }),
      });
      await expect(
        invalid.verify(AuthProvider.KAKAO, 'kakao-token'),
      ).rejects.toBeInstanceOf(SocialTokenError);

      const down = kakao({
        'https://kapi.kakao.com/v1/user/access_token_info': () =>
          jsonResponse(503, {}),
      });
      await expect(
        down.verify(AuthProvider.KAKAO, 'kakao-token'),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
    });
  });

  it('rejects a Naver response that is not a success', async () => {
    const v = verifierWith();
    v.useFetch(
      fakeFetch({
        'https://openapi.naver.com/v1/nid/me': () =>
          jsonResponse(200, {
            resultcode: '024',
            message: 'Authentication failed',
          }),
      }),
    );
    await expect(
      v.verify(AuthProvider.NAVER, 'naver-token'),
    ).rejects.toBeInstanceOf(SocialTokenError);
  });
});
