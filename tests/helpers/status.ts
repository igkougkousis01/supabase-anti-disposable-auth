/**
 * Builds a full {@link StatusReport} for a live database.
 *
 * `statusExitCode()` judges the whole report — guard schema, strict mode and remote
 * activation together — so an integration test that only has a `GuardSchemaStatus`
 * cannot construct one by hand without inventing the other halves. Reading strict mode
 * from the same live connection keeps that half real rather than stubbed, which is the
 * point of an integration test.
 */

import { readGuardSchemaStatus } from '../../src/database/schema-status.js';
import type { GuardSchemaStatus } from '../../src/database/schema-status.js';
import { readStrictModeStatus } from '../../src/database/strict-trigger.js';
import type { StatusReport } from '../../src/commands/status.js';
import type { DatabaseConnection } from '../../src/database/types.js';

export async function statusReportFor(
  connection: DatabaseConnection,
  schema?: GuardSchemaStatus,
  remote: StatusReport['remote'] = { kind: 'not-checked' },
): Promise<StatusReport> {
  const resolved = schema ?? (await readGuardSchemaStatus(connection));

  return {
    target: connection.target,
    schema: resolved,
    remote,
    strict: await readStrictModeStatus(connection, {
      guardHealthy: resolved.health === 'complete',
    }),
  };
}
