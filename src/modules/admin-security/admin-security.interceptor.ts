import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { AdminSecurityService } from './admin-security.service';
import { adminError, administrativePath, adminMfaRequired } from './admin-security.policy';

/** Uses matched controller metadata, not caller URL spelling/case/encoding. Guards run first. */
@Injectable()
export class AdminSecurityInterceptor implements NestInterceptor {
  constructor(private readonly security: AdminSecurityService) {}
  async intercept(context: ExecutionContext, next: CallHandler) {
    const base = Reflect.getMetadata(PATH_METADATA, context.getClass()) ?? '';
    const suffix = Reflect.getMetadata(PATH_METADATA, context.getHandler()) ?? '';
    const bases = Array.isArray(base) ? base : [base], suffixes = Array.isArray(suffix) ? suffix : [suffix];
    const paths = bases.flatMap(b => suffixes.map(s => ('/' + b + '/' + s).replace(/\/+/g, '/').replace(/\/$/, '')));
    if (!paths.some(administrativePath) || !adminMfaRequired()) return next.handle();
    const req = context.switchToHttp().getRequest(), res = context.switchToHttp().getResponse();
    res.setHeader('Cache-Control', 'no-store');
    await this.security.checkActor(req.user);
    if (paths.length !== 1) throw adminError('ADMIN_ROUTE_REVIEW_REQUIRED', 503);
    let path = paths[0];
    path = path.replace(/:([A-Za-z0-9_]+)/g, (_: string, key: string) => {
      const v = req.params?.[key];
      if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v)) throw adminError('ACTION_INVALID', 400);
      return v;
    });
    const method = req.method.toUpperCase();
    const read = ['GET','HEAD','OPTIONS'].includes(method) || (method === 'POST' && path === '/owner/refunds/quotes');
    if (!read && Object.keys(req.query ?? {}).length) throw adminError('ACTION_QUERY_NOT_SUPPORTED', 400);
    await this.security.authorize(req.user, req.headers.authorization, req.headers['x-admin-session'], req.headers['x-admin-action'],
      read ? undefined : { method, path, body: req.body ?? {}, idempotencyKey: req.headers['idempotency-key'] ?? null });
    return next.handle();
  }
}
