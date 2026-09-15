import { DataSource } from 'typeorm';
export const ownerPermissions = [
  'OWNER',
  'CATALOG',
  'FULFILLMENT',
  'WAREHOUSE',
  'ANNOUNCEMENTS',
];
/** Infrastructure-only bootstrap/revoke. No public grant endpoint or default owner. */
export async function ownerAccess(
  db: DataSource,
  userId: number,
  email: string,
  action: 'grant' | 'revoke',
  apply = false,
) {
  if (
    !Number.isSafeInteger(userId) ||
    userId < 1 ||
    !email ||
    !['grant', 'revoke'].includes(action)
  )
    throw new Error(
      'Exact existing user ID, email and grant/revoke action required',
    );
  return db.transaction(async (m) => {
    const [u] = await m.query(
      'SELECT id,email,auth_version FROM users WHERE id=$1 FOR UPDATE',
      [userId],
    );
    if (!u || u.email !== email)
      throw new Error('Existing account ID and email do not match');
    const permissions = await m.query(
      'SELECT permission,active FROM operations_permissions WHERE user_id=$1 ORDER BY permission',
      [userId],
    );
    if (apply) {
      if (action === 'grant') {
        for (const p of ownerPermissions)
          await m.query(
            'INSERT INTO operations_permissions(user_id,permission,active) VALUES($1,$2,true) ON CONFLICT(user_id,permission) DO UPDATE SET active=true',
            [userId, p],
          );
        await m.query(
          'INSERT INTO support_staff(user_id,active) VALUES($1,true) ON CONFLICT(user_id) DO UPDATE SET active=true',
          [userId],
        );
      } else {
        await m.query(
          'UPDATE operations_permissions SET active=false WHERE user_id=$1',
          [userId],
        );
        await m.query(
          'UPDATE support_staff SET active=false WHERE user_id=$1',
          [userId],
        );
      }
      await m.query(
        'UPDATE users SET auth_version=auth_version+1 WHERE id=$1',
        [userId],
      );
      await m.query(
        "INSERT INTO operations_events(actor_id,target_type,target_id,event,detail) VALUES($1,'OWNER',$2,$3,$4)",
        [
          userId,
          String(userId),
          'ACCESS_' + action.toUpperCase(),
          JSON.stringify({
            source: 'infrastructure-cli',
            permissionsBefore: permissions,
            requiresLogin: true,
          }),
        ],
      );
    }
    return {
      userId,
      action,
      applied: apply,
      permissionsBefore: permissions,
      permissionsAfter: action === 'grant' ? ownerPermissions : [],
      requiresLogin: apply,
    };
  });
}
