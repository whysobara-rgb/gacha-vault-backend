import { HttpException, HttpStatus } from '@nestjs/common';
import { ResponseCode } from '../constants/response-code.constant';

/**
 * Business exception carrying both an HTTP status and a business-level
 * response code, so the global exception filter can produce a consistent
 * error payload: { statusCode, message, errors, url }.
 */
export class BusinessException extends HttpException {
  public readonly responseCode: ResponseCode;
  public readonly errors: string[];

  constructor(
    responseCode: ResponseCode,
    message: string,
    httpStatus: HttpStatus = HttpStatus.BAD_REQUEST,
    errors: string[] = [],
  ) {
    super(message, httpStatus);
    this.responseCode = responseCode;
    this.errors = errors;
  }
}
