"""Explicit hosted targets, verified TLS, transactional checksummed migrations."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TARGETS = {'test': 'cimyhlakeloysxaquoqg', 'development': 'syisdkvnkbmbsbvchdgb'}
HOST = 'aws-1-ca-central-1.pooler.supabase.com'


def connection(target):
    if target not in TARGETS:
        raise ValueError('Unrecognized database target')
    password = (ROOT / '.local' / f'db-{target}-password.txt').read_text().rstrip('\r\n')
    if not password:
        raise ValueError('Empty database credential')
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    env.update(PGPASSWORD=password, PGSSLMODE='verify-full',
               PGSSLROOTCERT=str(ROOT / '.local/supabase-ca.crt'), PGCONNECT_TIMEOUT='10')
    exe = shutil.which('psql')
    if not exe:
        raise ValueError('psql is required')
    args = [exe, '-X', '-w', '-v', 'ON_ERROR_STOP=1', '-qAt', '-h', HOST,
            '-p', '5432', '-U', f'postgres.{TARGETS[target]}', '-d', 'postgres']
    return args, env


def execute(target, sql, timeout=40):
    args, env = connection(target)
    result = subprocess.run(args, input=sql, env=env, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Only return sanitized diagnostics; never include connection environment.
        message = result.stderr.replace(env['PGPASSWORD'], '[REDACTED]')
        raise RuntimeError(message)
    return result.stdout.strip()


def guard_test(target, confirm):
    if target != 'test' or confirm != TARGETS['test']:
        raise ValueError('Destructive fixtures require the exact isolated test project reference')


def bootstrap(target):
    ref = TARGETS[target]
    execute(target, f"""BEGIN;
SELECT pg_advisory_xact_lock(734003);
DO $$ BEGIN
 IF to_regnamespace('sequence_meta') IS NULL AND
    (to_regnamespace('sequence_private') IS NOT NULL OR EXISTS
     (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'seq\\_%')) THEN
  RAISE EXCEPTION 'Unrecognized existing application objects';
 END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS sequence_meta;
REVOKE ALL ON SCHEMA sequence_meta FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS sequence_meta.environment (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), project_ref text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('test','development')));
INSERT INTO sequence_meta.environment VALUES(true,'{ref}','{target}') ON CONFLICT DO NOTHING;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM sequence_meta.environment WHERE project_ref='{ref}' AND purpose='{target}') THEN
  RAISE EXCEPTION 'Project marker mismatch';
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS sequence_meta.migrations (
 version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON ALL TABLES IN SCHEMA sequence_meta FROM PUBLIC, anon, authenticated, service_role;
COMMIT;""")


def migrate(target):
    bootstrap(target)
    for path in sorted((ROOT / 'supabase/migrations').glob('*.sql')):
        sql = path.read_text()
        digest = hashlib.sha256(sql.encode()).hexdigest()
        # Filename comes from repository, but still enforce an identifier-safe format.
        if not all(c.isalnum() or c in '._-' for c in path.name):
            raise ValueError('Invalid migration filename')
        applied = execute(target, f"SELECT checksum FROM sequence_meta.migrations WHERE version='{path.name}';")
        if applied:
            if applied != digest:
                raise ValueError(f'Applied migration changed: {path.name}')
            print(f'UNCHANGED {path.name}')
            continue
        execute(target, f"""BEGIN;
SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(734003);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM sequence_meta.migrations WHERE version='{path.name}') THEN
 RAISE EXCEPTION 'Concurrent migration; rerun'; END IF; END $$;
{sql}
INSERT INTO sequence_meta.migrations(version,checksum) VALUES('{path.name}','{digest}');
COMMIT;""")
        print(f'APPLIED {path.name}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['check', 'migrate'])
    parser.add_argument('--target', required=True, choices=list(TARGETS))
    args = parser.parse_args()
    if args.command == 'check':
        print(execute(args.target, 'BEGIN READ ONLY; SELECT current_database(), current_user; COMMIT;'))
    else:
        migrate(args.target)

# Library-only rebuild: the test runner supplies the explicit project confirmation.
# RESTRICT everywhere prevents deleting unknown dependent objects via CASCADE.
def rebuild_test(target, confirm):
    guard_test(target, confirm)
    ref = execute(target, "SELECT project_ref FROM sequence_meta.environment WHERE purpose='test';")
    if ref != TARGETS['test']:
        raise ValueError('Test marker mismatch')
    if execute(target, 'SELECT count(*) FROM public.seq_workspaces;') != '0':
        raise ValueError('Rebuild requires empty application workspace data')
    private = ['deletion_tombstones','provider_readings','usage_counters','management_requests','auth_audit','auth_rate_limits','login_transactions','auth_sessions','send_reservations','attempt_results','attempts','execution_leases','account_execution_state','logical_actions','enrollments','observations','approval_recipients','approvals','content_revisions','access_allowlist']
    public = ['list_memberships','campaigns','lists','prospects','accounts','workspaces']
    sql='BEGIN; SELECT pg_advisory_xact_lock(734003);'
    # Recheck inside transaction after serialization against migration/rebuild runners.
    sql += "DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.seq_workspaces) THEN RAISE EXCEPTION 'Nonempty target'; END IF; END $$;"
    for table, trigger in [('public.seq_campaigns','invalidate_campaign_intent'),('public.seq_prospects','invalidate_profile_approval'),('sequence_private.logical_actions','guard_action_campaign')]:
        sql+=f'DROP TRIGGER IF EXISTS {trigger} ON {table} RESTRICT;'
    for fun in ['invalidate_campaign_intent()','invalidate_profile_approval()','guard_action_campaign()']:
        sql+=f'DROP FUNCTION IF EXISTS sequence_private.{fun} RESTRICT;'
    # S3-006 lifecycle objects depend on tombstone/reading row types; remove them before tables.
    for fun in ['public.seq_delete_workspace(jsonb)','public.seq_export(text,integer)','sequence_private.operator_remove_identity(uuid,uuid)','sequence_private.quota_status()','sequence_private.meter(text,numeric,numeric,timestamptz,numeric,text)','sequence_private.usage_record(bigint)']:
        sql+=f'DROP FUNCTION IF EXISTS {fun} RESTRICT;'
    sql += 'DROP FUNCTION IF EXISTS public.seq_manage(text,jsonb) RESTRICT;'
    sql += 'DROP TRIGGER IF EXISTS guard_prospect_capacity ON public.seq_prospects RESTRICT;'
    for fun in ['guard_prospect_capacity()','render_management(jsonb,jsonb)','management_catalog()']:
        sql+=f'DROP FUNCTION IF EXISTS sequence_private.{fun} RESTRICT;'
    sql += 'DROP TRIGGER IF EXISTS revoke_product_sessions ON sequence_private.access_allowlist RESTRICT;'
    for fun in ['operator_admission(uuid,boolean,uuid)','auth_maintenance()','auth_record_event(text,uuid)','auth_rate_limit(text,text)','auth_session_operation(text,jsonb)','revoke_admission_sessions()','live_product_session(uuid,text)']:
        sql+=f'DROP FUNCTION IF EXISTS sequence_private.{fun} RESTRICT;'
    # Functions whose return/row types may depend on tables are removed first.
    for fun in ['resolve_reservation(uuid,uuid,uuid)','record_possible_send(uuid,uuid,uuid)','acquire_storage_lease(uuid,uuid,uuid)']:
        sql+=f'DROP FUNCTION sequence_private.{fun} RESTRICT;'
    for name in private: sql+=f'DROP TABLE sequence_private.{name} RESTRICT;'
    for name in public: sql+=f'DROP TABLE public.seq_{name} RESTRICT;'
    for fun in ['guard_attempt()','bump_revision()','guard_approver()','owns_workspace(uuid)']:
        sql+=f'DROP FUNCTION sequence_private.{fun} RESTRICT;'
    sql+='DROP SCHEMA sequence_private RESTRICT; DELETE FROM sequence_meta.migrations; COMMIT;'
    execute(target,sql)
    migrate(target)


if __name__ == "__main__":
    main()
