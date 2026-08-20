import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { BusinessException } from '../exceptions/business.exception';
import { ResponseCode } from '../constants/response-code.constant';

interface ErrorResponseBody {
  statusCode: ResponseCode;
  message: string;
  errors: string[];
  url: string;
}

/**
 * Global exception filter producing a consistent error envelope:
 * { statusCode, message, errors, url }
 *
 * - BusinessException -> uses its own responseCode/message/errors
 * - class-validator ValidationPipe failures (BadRequestException with a
 *   string[] message) -> statusCode 10001 (VALIDATION_FAILED)
 * - any other HttpException -> mapped by HTTP status
 * - unknown errors -> 10099 (INTERNAL_ERROR), logged server-side
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { httpStatus, body } = this.buildErrorBody(exception, request.url);

    if (httpStatus >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${body.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(httpStatus).json(body);
  }

  private buildErrorBody(
    exception: unknown,
    url: string,
  ): { httpStatus: number; body: ErrorResponseBody } {
    if (exception instanceof BusinessException) {
      return {
        httpStatus: exception.getStatus(),
        body: {
          statusCode: exception.responseCode,
          message: exception.message,
          errors: exception.errors,
          url,
        },
      };
    }

    if (exception instanceof BadRequestException) {
      const res = exception.getResponse();
      const messages =
        typeof res === 'object' && res !== null && 'message' in res
          ? (res as { message: string | string[] }).message
          : exception.message;
      const errors = Array.isArray(messages) ? messages : [messages];
      return {
        httpStatus: HttpStatus.BAD_REQUEST,
        body: {
          statusCode: ResponseCode.VALIDATION_FAILED,
          message: 'Validation failed',
          errors,
          url,
        },
      };
    }

    if (exception instanceof HttpException) {
      const httpStatus = exception.getStatus();
      const res = exception.getResponse();
      const message =
        typeof res === 'object' && res !== null && 'message' in res
          ? (res as { message: string }).message
          : exception.message;

      return {
        httpStatus,
        body: {
          statusCode: this.mapHttpStatusToResponseCode(httpStatus),
          message: typeof message === 'string' ? message : exception.message,
          errors: [],
          url,
        },
      };
    }

    return {
      httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        statusCode: ResponseCode.INTERNAL_ERROR,
        message: 'Internal server error',
        errors: [],
        url,
      },
    };
  }

  private mapHttpStatusToResponseCode(httpStatus: number): ResponseCode {
    switch (httpStatus) {
      case HttpStatus.UNAUTHORIZED:
        return ResponseCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ResponseCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ResponseCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ResponseCode.CONFLICT;
      default:
        return ResponseCode.INTERNAL_ERROR;
    }
  }
}
