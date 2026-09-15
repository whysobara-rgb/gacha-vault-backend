import db from '../../data-source';
import { ownerAccess } from './owner-access';
async function main() {
  const args = process.argv.slice(2),
    allowed = ['--user-id', '--email', '--action', '--apply'],
    values: Record<string, string> = {};
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (
      !allowed.includes(key) ||
      Object.prototype.hasOwnProperty.call(values, key) ||
      (key === '--apply' && apply)
    )
      throw new Error(
        'Usage: --user-id ID --email EXACT_EMAIL --action grant|revoke [--apply]',
      );
    if (key === '--apply') {
      apply = true;
      continue;
    }
    if (!args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error('Missing argument');
    values[key] = args[++i];
  }
  if (
    !/^\d+$/.test(values['--user-id'] || '') ||
    !['grant', 'revoke'].includes(values['--action']) ||
    !values['--email']
  )
    throw new Error('Exact existing user ID/email and action are required');
  try {
    await db.initialize();
    console.log(
      JSON.stringify(
        await ownerAccess(
          db,
          Number(values['--user-id']),
          values['--email'],
          values['--action'] as 'grant' | 'revoke',
          apply,
        ),
        null,
        2,
      ),
    );
  } finally {
    if (db.isInitialized) await db.destroy();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
