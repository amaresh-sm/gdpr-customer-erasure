import { copyFile, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const mutation = process.argv[2];

async function replaceRequired(path, before, after) {
  const source = await readFile(path, 'utf8');
  if (!source.includes(before)) throw new Error(`mutation anchor missing in ${path}`);
  await writeFile(path, source.replace(before, after), 'utf8');
}

if (mutation === 'primary-record-only') {
  await copyFile('.naive_fixes/primary-workflow.ts', 'apps/privacy-service/src/workflow.ts');
} else if (mutation === 'missing-notification-replay') {
  const path = 'apps/notification-worker/src/main.ts';
  await replaceRequired(path, "import { isErasedSubject } from '../../../packages/privacy/src/subjects.js';\n", '');
  await replaceRequired(path, `    const customerId = typeof event.payload.customerId === 'string' ? event.payload.customerId : null;
    if (customerId && await isErasedSubject(event.merchantId, customerId, client)) {
      await client.query(\`UPDATE operations.inbox_events SET status='processed',processed_at=now()
        WHERE consumer='notification-worker' AND event_id=$1\`, [event.eventId]);
      return;
    }
`, `    const customerId = typeof event.payload.customerId === 'string' ? event.payload.customerId : null;
`);
} else if (mutation === 'blanket-financial-delete') {
  await copyFile('.naive_fixes/blanket-financial-records.ts',
    'apps/privacy-service/src/handlers/financial-records.ts');
} else {
  throw new Error(`unknown mutation ${String(mutation)}`);
}
