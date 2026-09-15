import db from '../../data-source';
import { fixtureEmail, preparePreviewFixture } from './preview-fixture';

async function run() {
  fixtureEmail(process.env); // Fail before opening any DB connection.
  await db.initialize();
  try {
    const result = await preparePreviewFixture(db, process.env);
    console.log(
      `TEST_FIXTURE_READY gachaId=${result.gachaId} grant=${result.granted ? 'created' : 'already-recorded'}`,
    );
  } finally {
    await db.destroy();
  }
}
run().catch(() => {
  // Do not print credentials, account identifiers, or driver connection errors.
  console.error(
    'TEST_FIXTURE_FAILED: check test flags, registered account and migrated DB; no partial changes committed',
  );
  process.exitCode = 1;
});
