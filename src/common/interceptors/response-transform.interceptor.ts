import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ResponseCode } from '../constants/response-code.constant';

export interface SuccessResponse<T> {
  statusCode: ResponseCode;
  message: string;
  data: T;
}

/**
 * Wraps every successful controller response in the app-wide envelope:
 * { statusCode: 10000, message: "success", data: <original payload> }
 */
@Injectable()
export class ResponseTransformInterceptor<T>
  implements NestInterceptor<T, SuccessResponse<T>>
{
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<SuccessResponse<T>> {
    return next.handle().pipe(
      map((data) => ({
        statusCode: ResponseCode.SUCCESS,
        message: 'success',
        data: data ?? null,
      })),
    );
  }
}
