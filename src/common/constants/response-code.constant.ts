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
  TOPUP_LIMIT_EXCEEDED = 10007,
  ALREADY_CHECKED_IN = 10008,
  SOLD_OUT = 10009,
  TERMS_REQUIRED = 10010,
  EMAIL_ALREADY_REGISTERED = 10011,
  SOCIAL_PROVIDER_UNAVAILABLE = 10012,
  ACTIVE_SHIPMENTS = 10013,
  PAYMENT_FAILED = 10014,
  /** Payments are not configured on this server. */
  PAYMENT_UNAVAILABLE = 10015,
  /** Approval outcome not known yet; retry confirm with the same values. */
  PAYMENT_PENDING = 10016,
  INTERNAL_ERROR = 10099,
}
