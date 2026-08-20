/**
 * Business-level response codes returned in the `statusCode` field of every
 * API response body. These are independent from the HTTP status code.
 */
export enum ResponseCode {
  SUCCESS = 10000,
  VALIDATION_FAILED = 10001,
  UNAUTHORIZED = 10002,
  FORBIDDEN = 10003,
  NOT_FOUND = 10004,
  CONFLICT = 10005,
  INSUFFICIENT_BALANCE = 10006,
  INTERNAL_ERROR = 10099,
}
