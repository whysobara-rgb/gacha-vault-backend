import { IsInt, Max, Min } from 'class-validator';

/**
 * Demo/test-only top-up endpoint DTO. In a real production deployment this
 * would be replaced by a payment-gateway webhook confirming a purchase;
 * kept here so the Flutter WalletPage's "충전하기" flow has something to
 * call during development.
 */
export class TopupDto {
  @IsInt()
  @Min(100)
  @Max(1000000)
  amount: number;
}
