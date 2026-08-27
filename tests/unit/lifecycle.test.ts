import { describe, expect, it } from 'vitest';

import { extractCreateFunctionSql, extractFunctionSource } from '../../src/database/lifecycle.js';
import { loadMigrationFiles } from '../../src/database/migrations.js';
import { RESTORE_AUTH_HOOK_GRANTS_SQL } from '../../src/database/repair.js';

describe('leaf repair definition extraction', () => {
  it('extracts only the expected hook CREATE FUNCTION statement', async () => {
    const files = await loadMigrationFiles();
    const migration = files.find((file) => file.version === '006');
    expect(migration).toBeDefined();

    const sql = extractCreateFunctionSql(migration?.sql ?? '', 'before_user_created');

    expect(sql).toMatch(/^create or replace function guard\.before_user_created\(event jsonb\)/i);
    expect(sql).toContain('guard.is_disposable_domain(candidate_email)');
    expect(sql).not.toContain('grant execute');
    expect(sql).not.toContain('schema_migrations');
  });

  it('extracts the exact source used for definition ownership checks', async () => {
    const files = await loadMigrationFiles();
    const migration = files.find((file) => file.version === '008');
    const source = extractFunctionSource(migration?.sql ?? '', 'enforce_auth_user_email');

    expect(source).toContain('return new;');
    expect(source).toContain('guard.is_disposable_domain(new.email::text)');
    expect(source).not.toContain('create or replace function');
  });
});

describe('grant repair boundary', () => {
  it('contains exactly the six documented least-privilege grants', () => {
    const grants = RESTORE_AUTH_HOOK_GRANTS_SQL.match(/\bgrant\b/gi) ?? [];

    expect(grants).toHaveLength(6);
    expect(RESTORE_AUTH_HOOK_GRANTS_SQL).toContain('grant usage on schema guard');
    expect(RESTORE_AUTH_HOOK_GRANTS_SQL).toContain(
      'grant execute on function guard.before_user_created(jsonb)',
    );
    expect(RESTORE_AUTH_HOOK_GRANTS_SQL).toContain('grant select on table guard.allowed_domains');
    expect(RESTORE_AUTH_HOOK_GRANTS_SQL).not.toMatch(/\b(insert|update|delete|truncate|create)\b/i);
    expect(RESTORE_AUTH_HOOK_GRANTS_SQL).not.toContain('guard.sync_metadata');
    expect(RESTORE_AUTH_HOOK_GRANTS_SQL).not.toContain('guard.schema_migrations');
  });
});
