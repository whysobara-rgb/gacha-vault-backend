import { notify } from '../supply/supply.db';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import {
  accountLock,
  fail,
  plain,
  staffAccess,
} from './account-support.policy';
import { digest, validKey } from '../conversions/conversion.policy';
import { validatePage } from '../commerce/commerce.policy';
import {
  TicketDto,
  TicketListDto,
  TicketStatusDto,
} from './account-support.dto';

@Injectable()
export class SupportService {
  constructor(private readonly db: DataSource) {}
  private receipt(r: any) {
    return {
      ticketId: r.id,
      category: r.category,
      subject: r.subject,
      orderId: r.order_id,
      status: r.status,
      version: r.version,
      lastSequence: r.last_sequence,
      unread: r.last_staff_sequence > r.customer_read_sequence,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  private async permission(
    m: EntityManager,
    actor: AuthenticatedUser,
    staff: boolean,
    write = false,
  ) {
    if (write) await accountLock(m, actor);
    if (staff) await staffAccess(m, actor.userId, write);
  }
  private async ticket(
    m: EntityManager,
    userId: number,
    id: string,
    staff: boolean,
    lock = false,
  ) {
    const [r] = await m.query(
      `SELECT * FROM support_tickets WHERE id=$1 ${staff ? '' : 'AND user_id=$2'} ${lock ? 'FOR UPDATE' : ''}`,
      staff ? [validKey(id)] : [validKey(id), userId],
    );
    if (!r) throw fail('문의를 찾을 수 없습니다', 404);
    return r;
  }
  private async event(
    m: EntityManager,
    actor: AuthenticatedUser,
    r: any,
    event: string,
  ) {
    await m.query(
      'INSERT INTO support_events(ticket_id,actor_id,event,version) VALUES($1,$2,$3,$4)',
      [r.id, actor.userId, event, r.version],
    );
  }
  private async rate(m: EntityManager, userId: number) {
    const [{ n }] = await m.query(
      "SELECT count(*)::int AS n FROM support_messages WHERE actor_id=$1 AND created_at>clock_timestamp()-interval '1 minute'",
      [userId],
    );
    if (n >= 30) throw fail('메시지가 많습니다. 잠시 후 다시 보내주세요', 429);
  }
  async create(actor: AuthenticatedUser, key: string, dto: TicketDto) {
    key = validKey(key);
    const subject = plain(dto.subject, 2, 100),
      body = plain(dto.body, 1, 4000, true),
      orderId = dto.orderId ? validKey(dto.orderId) : null;
    if (
      !['PAYMENT', 'REFUND', 'SHIPPING', 'ACCOUNT', 'OTHER'].includes(
        dto.category,
      )
    )
      throw fail('문의 유형을 확인해주세요', 400);
    const hash = digest({ subject, body, orderId, category: dto.category });
    return this.db.transaction(async (m) => {
      await accountLock(m, actor);
      const [prior] = await m.query(
        'SELECT * FROM support_tickets WHERE user_id=$1 AND idempotency_key=$2',
        [actor.userId, key],
      );
      if (prior) {
        if (prior.request_hash !== hash)
          throw fail('같은 요청 번호의 내용이 다릅니다', 409);
        return this.receipt(prior);
      }
      if (orderId) {
        const [order] = await m.query(
          'SELECT id FROM capsule_orders WHERE id=$1 AND user_id=$2',
          [orderId, actor.userId],
        );
        if (!order) throw fail('본인의 구매 주문을 선택해주세요', 404);
      }
      const [{ open, daily }] = await m.query(
        "SELECT count(*) FILTER(WHERE status<>'CLOSED')::int AS open,count(*) FILTER(WHERE created_at>clock_timestamp()-interval '1 day')::int AS daily FROM support_tickets WHERE user_id=$1",
        [actor.userId],
      );
      if (open >= 20 || daily >= 50)
        throw fail('기존 문의를 확인한 후 다시 접수해주세요', 429);
      await this.rate(m, actor.userId);
      const [r] = await m.query(
        'INSERT INTO support_tickets(id,user_id,idempotency_key,request_hash,category,subject,order_id,customer_read_sequence) VALUES($1,$2,$3,$4,$5,$6,$7,1) RETURNING *',
        [randomUUID(), actor.userId, key, hash, dto.category, subject, orderId],
      );
      await m.query(
        "INSERT INTO support_messages(id,ticket_id,actor_id,actor_role,idempotency_key,sequence,body) VALUES($1,$2,$3,'CUSTOMER',$4,1,$5)",
        [randomUUID(), r.id, actor.userId, key, body],
      );
      await this.event(m, actor, r, 'CREATED');
      return this.receipt(r);
    });
  }
  async byKey(userId: number, key: string) {
    const [r] = await this.db.query(
      'SELECT * FROM support_tickets WHERE user_id=$1 AND idempotency_key=$2',
      [userId, validKey(key)],
    );
    if (!r) throw fail('확인된 문의가 없습니다', 404);
    return this.receipt(r);
  }
  async list(actor: AuthenticatedUser, q: TicketListDto, staff = false) {
    validatePage(q.page, q.limit);
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.permission(m, actor, staff);
      const parameters: any[] = [],
        clauses: string[] = [];
      if (!staff) {
        parameters.push(actor.userId);
        clauses.push(`user_id=$${parameters.length}`);
      }
      if (q.status) {
        if (!['OPEN', 'ANSWERED', 'CLOSED'].includes(q.status))
          throw fail('상태를 확인해주세요', 400);
        parameters.push(q.status);
        clauses.push(`status=$${parameters.length}`);
      }
      const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
      const [{ n }] = await m.query(
        `SELECT count(*)::int AS n FROM support_tickets ${where}`,
        parameters,
      );
      const rows = await m.query(
        `SELECT * FROM support_tickets ${where} ORDER BY created_at DESC,id DESC LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
        [...parameters, q.limit, (q.page - 1) * q.limit],
      );
      return {
        items: rows.map((r) => this.receipt(r)),
        totalCount: n,
        page: q.page,
        limit: q.limit,
      };
    });
  }
  async detail(actor: AuthenticatedUser, id: string, after = 0, staff = false) {
    if (!Number.isInteger(after) || after < 0)
      throw fail('메시지 위치를 확인해주세요', 400);
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.permission(m, actor, staff);
      const r = await this.ticket(m, actor.userId, id, staff);
      const messages = await m.query(
        `SELECT id AS "messageId",sequence,actor_role AS "authorRole",body,created_at AS "createdAt" FROM support_messages WHERE ticket_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 50`,
        [id, after],
      );
      const last = messages.length
        ? messages[messages.length - 1].sequence
        : after;
      return {
        ticket: this.receipt(r),
        messages,
        hasMore: last < r.last_sequence,
        nextAfter: last,
      };
    });
  }
  async messageByKey(actor: AuthenticatedUser, key: string, staff = false) {
    return this.db.transaction(async (m) => {
      await this.permission(m, actor, staff);
      const [r] = await m.query(
        'SELECT * FROM support_messages WHERE actor_id=$1 AND idempotency_key=$2',
        [actor.userId, validKey(key)],
      );
      if (!r || r.actor_role !== (staff ? 'SUPPORT' : 'CUSTOMER'))
        throw fail('확인된 메시지가 없습니다', 404);
      await this.ticket(m, actor.userId, r.ticket_id, staff);
      return { ticketId: r.ticket_id, messageId: r.id, sequence: r.sequence };
    });
  }
  async reply(
    actor: AuthenticatedUser,
    id: string,
    key: string,
    value: string,
    staff = false,
  ) {
    key = validKey(key);
    const body = plain(value, 1, 4000, true),
      role = staff ? 'SUPPORT' : 'CUSTOMER';
    return this.db.transaction(async (m) => {
      await this.permission(m, actor, staff, true);
      const r = await this.ticket(m, actor.userId, id, staff, true);
      const [prior] = await m.query(
        'SELECT * FROM support_messages WHERE actor_id=$1 AND idempotency_key=$2',
        [actor.userId, key],
      );
      if (prior) {
        if (
          prior.ticket_id !== id ||
          prior.body !== body ||
          prior.actor_role !== role
        )
          throw fail('같은 요청 번호의 내용이 다릅니다', 409);
        return { ticketId: id, messageId: prior.id, sequence: prior.sequence };
      }
      if (r.status === 'CLOSED')
        throw fail('종료된 문의입니다. 다시 열고 내용을 보내주세요', 409);
      await this.rate(m, actor.userId);
      const messageId = randomUUID(),
        sequence = r.last_sequence + 1;
      await m.query(
        'INSERT INTO support_messages(id,ticket_id,actor_id,actor_role,idempotency_key,sequence,body) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [messageId, id, actor.userId, role, key, sequence, body],
      );
      const [updated] = await m.query(
        `UPDATE support_tickets SET last_sequence=$2,last_staff_sequence=CASE WHEN $3 THEN $2 ELSE last_staff_sequence END,status=$4,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
        [id, sequence, staff, staff ? 'ANSWERED' : 'OPEN'],
      );
      await this.event(
        m,
        actor,
        updated,
        staff ? 'STAFF_REPLIED' : 'CUSTOMER_REPLIED',
      );
      if (staff)
        await notify(
          m,
          r.user_id,
          `support:${messageId}`,
          'SUPPORT_REPLY',
          id,
          '문의에 답변이 도착했어요',
          '고객센터에서 답변을 확인해주세요.',
        );
      return { ticketId: id, messageId, sequence };
    });
  }
  async status(
    actor: AuthenticatedUser,
    id: string,
    dto: TicketStatusDto,
    staff = false,
  ) {
    if (!['OPEN', 'CLOSED'].includes(dto.status))
      throw fail('문의 상태를 확인해주세요', 400);
    return this.db.transaction(async (m) => {
      await this.permission(m, actor, staff, true);
      const r = await this.ticket(m, actor.userId, id, staff, true);
      if (r.status === dto.status) return this.receipt(r);
      if (r.version !== dto.expectedVersion)
        throw fail('새 답변이 있습니다. 문의를 새로 확인해주세요', 409);
      const [updated] = await m.query(
        'UPDATE support_tickets SET status=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
        [id, dto.status],
      );
      await this.event(
        m,
        actor,
        updated,
        dto.status === 'CLOSED' ? 'CLOSED' : 'REOPENED',
      );
      return this.receipt(updated);
    });
  }
  async markRead(actor: AuthenticatedUser, id: string, through: number) {
    return this.db.transaction(async (m) => {
      await accountLock(m, actor);
      const r = await this.ticket(m, actor.userId, id, false, true);
      if (
        !Number.isInteger(through) ||
        through < 0 ||
        through > r.last_sequence
      )
        throw fail('확인한 메시지를 다시 불러와주세요', 400);
      await m.query(
        'UPDATE support_tickets SET customer_read_sequence=GREATEST(customer_read_sequence,$2) WHERE id=$1',
        [id, through],
      );
      return { readThrough: Math.max(r.customer_read_sequence, through) };
    });
  }
  async closures(actor: AuthenticatedUser, q: TicketListDto) {
    validatePage(q.page, q.limit);
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await staffAccess(m, actor.userId);
      const [{ n }] = await m.query(
        "SELECT count(*)::int AS n FROM account_closure_requests WHERE status='REQUESTED'",
      );
      const rows = await m.query(
        `SELECT id AS "requestId",reason,summary,created_at AS "createdAt" FROM account_closure_requests WHERE status='REQUESTED' ORDER BY created_at,id LIMIT $1 OFFSET $2`,
        [q.limit, (q.page - 1) * q.limit],
      );
      return {
        items: rows,
        totalCount: n,
        page: q.page,
        limit: q.limit,
        completionEnabled: false,
      };
    });
  }
}
