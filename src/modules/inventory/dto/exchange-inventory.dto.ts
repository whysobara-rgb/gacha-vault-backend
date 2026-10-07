import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';

export class ExchangeInventoryDto {
  @ApiProperty({
    example: [12, 13],
    description: '포인트로 전환할 보관함 아이템 ID 목록 (1~100개)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  inventoryItemIds: number[];
}
