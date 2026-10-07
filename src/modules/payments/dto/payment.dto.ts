import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { TOPUP_PACKAGES } from '../../../common/constants/economy.constant';

export class CreatePaymentOrderDto {
  @ApiProperty({
    example: 'gp30000',
    enum: TOPUP_PACKAGES.map((p) => p.id),
  })
  @IsIn(TOPUP_PACKAGES.map((p) => p.id))
  packageId: string;
}

/** What the Toss widget hands back on success. */
export class ConfirmPaymentDto {
  @ApiProperty({ description: 'Toss paymentKey' })
  @IsString()
  @MaxLength(200)
  paymentKey: string;

  @ApiProperty({ description: 'POST /payments/orders가 발급한 orderId' })
  @IsString()
  @Matches(/^GV[0-9a-f]{32}$/)
  orderId: string;

  @ApiProperty({
    description: '결제 금액(원). 주문 금액과 다르면 승인하지 않습니다.',
  })
  @IsInt()
  @Min(1)
  amount: number;
}
