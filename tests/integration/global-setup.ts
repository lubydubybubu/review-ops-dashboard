import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { grantAppRole, runMigrations } from '../../src/server/db/migrate';
import { assertDisposableServer, assertGeneratedDatabase } from '../db-guard';

/**
 * Per run: create a brand-new database, migrate it from zero as the superuser, and give
 * a non-superuser role DML-only grants. Tests talk to the DB as that role, proving the
 * app needs no DDL at runtime. The database is dropped afterwards (KEEP_TEST_DB=1 keeps it).
 */

const BASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:localtest@127.0.0.1:55433/ops_test';
export const APP_ROLE = 'ops_app_test';
const APP_ROLE_PASSWORD = 'ops_app_test_pw';

declare module 'vitest' {
  export interface ProvidedContext {
    adminDbUrl: string;
    appDbUrl: string;
    testDbName: string;
  }
}

function withDatabase(url: string, database: string, credentials?: { user: string; password: string }): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (credentials) {
    u.username = credentials.user;
    u.password = credentials.password;
  }
  return u.toString();
}

export default async function setup(project: TestProject) {
  assertDisposableServer(BASE_URL);
  const dbName = `ops_test_${Date.now().toString(36)}_${process.pid}`;
  assertGeneratedDatabase(dbName);
  const maintenance = new pg.Client({ connectionString: withDatabase(BASE_URL, 'postgres') });
  await maintenance.connect();
  await maintenance.query(`create database ${maintenance.escapeIdentifier(dbName)}`);
  await maintenance.query(`
    do $$
    begin
      if not exists (select from pg_roles where rolname = '${APP_ROLE}') then
        create role ${APP_ROLE} login password '${APP_ROLE_PASSWORD}' nosuperuser nocreatedb nocreaterole;
      end if;
    end $$`);

  const adminDbUrl = withDatabase(BASE_URL, dbName);
  const admin = new pg.Client({ connectionString: adminDbUrl });
  await admin.connect();
  const result = await runMigrations(admin);
  if (result.alreadyApplied.length > 0 || result.applied.length === 0) {
    throw new Error('expected a fresh database to apply every migration from zero');
  }
  await grantAppRole(admin, APP_ROLE);
  await admin.end();
  console.log(`[integration] database ${dbName}: ${result.applied.length} migrations applied from zero`);

  project.provide('adminDbUrl', adminDbUrl);
  project.provide('appDbUrl', withDatabase(BASE_URL, dbName, { user: APP_ROLE, password: APP_ROLE_PASSWORD }));
  project.provide('testDbName', dbName);

  return async () => {
    if (process.env.KEEP_TEST_DB !== '1') {
      assertGeneratedDatabase(dbName);
      await maintenance.query(`drop database if exists ${maintenance.escapeIdentifier(dbName)} with (force)`);
    }
    await maintenance.end();
  };
}
