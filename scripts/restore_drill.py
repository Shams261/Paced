"""Timed restore drill: latest R2 backup into the isolated test project, ledger applied, everything held. Operator only."""
import argparse
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time

from backup import pg_bin, r2_credentials, ACCOUNT_ID, BUCKET
from database import ROOT, TARGETS, connection, execute, guard_test, migrate, rebuild_test
from r2 import R2Client


# Parents before children so foreign keys hold without superuser trigger control.
RESTORE_ORDER = ('public.seq_workspaces', 'public.seq_accounts', 'sequence_private.access_allowlist', 'sequence_private.auth_audit',
                 'public.seq_prospects', 'public.seq_lists', 'public.seq_list_memberships', 'public.seq_campaigns',
                 'sequence_private.content_revisions', 'sequence_private.approvals', 'sequence_private.approval_recipients',
                 'sequence_private.observations', 'sequence_private.enrollments', 'sequence_private.logical_actions',
                 'sequence_private.account_execution_state', 'sequence_private.execution_leases', 'sequence_private.attempts',
                 'sequence_private.attempt_results', 'sequence_private.send_reservations', 'sequence_private.management_requests',
                 'sequence_private.usage_counters', 'sequence_private.provider_readings', 'sequence_private.backup_log')


def gpg_decrypt(data):
    # Uses the operator's own keyring; the passphrase prompt appears in the terminal, never in this script.
    # Files instead of pipes, and GPG_TTY set, so the terminal pinentry can take over the screen.
    env = dict(os.environ)
    try:
        env['GPG_TTY'] = os.ttyname(0)
    except OSError:
        pass
    with tempfile.TemporaryDirectory(prefix='paced-gpg-') as folder:
        source, target = Path(folder) / 'in.gpg', Path(folder) / 'out.bin'
        source.write_bytes(data)
        result = subprocess.run(['gpg', '--quiet', '--yes', '--output', str(target), '--decrypt', str(source)], env=env, stderr=subprocess.PIPE, timeout=600)
        if result.returncode:
            raise RuntimeError('gpg decrypt failed: ' + result.stderr.decode(errors='replace')[:500])
        return target.read_bytes()


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--confirm-test-project', required=True)
    parser.add_argument('--key', help='backups/<stamp>.tar.gpg to restore (default: backups/latest.json pointer)')
    parser.add_argument('--keep-restored', action='store_true', help='Leave restored data in the test project (default: rebuild to empty afterwards)')
    args = parser.parse_args()
    guard_test('test', args.confirm_test_project)
    declared_start = time.monotonic()
    report = {'declaredStart': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'steps': {}}

    def step(name, fn):
        t = time.monotonic()
        value = fn()
        report['steps'][name] = round(time.monotonic() - t, 1)
        return value

    access_key, secret_key = r2_credentials()
    client = R2Client(os.environ.get('R2_ACCOUNT_ID', ACCOUNT_ID), os.environ.get('R2_BUCKET', BUCKET), access_key, secret_key)
    pointer = json.loads(client.get_object('backups/latest.json'))
    key = args.key or pointer['key']
    encrypted = step('download', lambda: client.get_object(key))
    if key == pointer['key'] and hashlib.sha256(encrypted).hexdigest() != pointer['sha256']:
        raise ValueError('Downloaded backup does not match the recorded checksum')
    archive = step('decrypt', lambda: gpg_decrypt(encrypted))
    work = Path(tempfile.mkdtemp(prefix='paced-restore-'))
    try:
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(work, filter='data')
        metadata = json.loads((work / 'metadata.json').read_text())
        if hashlib.sha256((work / 'data.dump').read_bytes()).hexdigest() != metadata['dumpSha256']:
            raise ValueError('Dump checksum inside the archive does not match')
        ledger_keys = sorted(k for k, _, _ in client.list_objects('ledger/'))
        ledger = [json.loads(line) for line in gpg_decrypt(client.get_object(ledger_keys[-1])).decode().splitlines() if line.strip()] if ledger_keys else []
        report['backup'] = {'key': key, 'migrationVersion': metadata['migrationVersion'], 'generatedAt': metadata['generatedAt'], 'ledgerEntries': len(ledger)}
        step('rebuild-empty-test', lambda: rebuild_test('test', TARGETS['test']))
        step('migrate', lambda: migrate('test'))
        current_version = execute('test', 'SELECT max(version) FROM sequence_meta.migrations;')
        report['schema'] = {'backup': metadata['migrationVersion'], 'current': current_version}
        # Identity rows first so ownership foreign keys hold; synthetic Auth rows carry no passwords or tokens.
        rows = (work / 'identities.csv').read_text().splitlines()[1:]
        inserts = []
        for row in rows:
            user_id, email, confirmed, _admitted, created = row.split(',')[:5]
            inserts.append(f"INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at) VALUES({literal(user_id)},'authenticated','authenticated',{literal(email)},{'now()' if confirmed == 't' else 'NULL'},{literal(created)}) ON CONFLICT (id) DO NOTHING;")
        if inserts:
            execute('test', 'BEGIN;' + ''.join(inserts) + 'COMMIT;')
        pg_args, env = connection('test')
        base = [pg_bin('pg_restore'), '--data-only', '--no-owner', '--no-acl', '-h', pg_args[pg_args.index('-h') + 1], '-p', '5432',
                '-U', pg_args[pg_args.index('-U') + 1], '-d', 'postgres']
        def do_restore():
            # The operator owns the tables but is not a superuser, so internal foreign-key triggers stay on
            # and parents are restored before children. User triggers (lease and approval guards) are
            # disabled only for the copy, because historical facts must load as they were.
            execute('test', 'BEGIN;' + ''.join(f'ALTER TABLE {t} DISABLE TRIGGER USER;' for t in RESTORE_ORDER) + 'COMMIT;')
            try:
                for table in RESTORE_ORDER:
                    schema, name = table.split('.')
                    result = subprocess.run(base + ['-n', schema, '-t', name, str(work / 'data.dump')], env=env, capture_output=True, text=True, timeout=1800)
                    if result.returncode or 'error:' in result.stderr:
                        raise RuntimeError(f'pg_restore failed for {table}: ' + result.stderr.replace(env['PGPASSWORD'], '[REDACTED]')[:1500])
            finally:
                execute('test', 'BEGIN;' + ''.join(f'ALTER TABLE {t} ENABLE TRIGGER USER;' for t in RESTORE_ORDER) + 'COMMIT;')
        step('pg_restore', do_restore)
        applied = step('apply-ledger', lambda: execute('test', f"SELECT sequence_private.apply_deletion_ledger({literal(json.dumps(ledger))}::jsonb);"))
        finalized = step('finalize-held', lambda: execute('test', "SELECT sequence_private.restore_finalize('{}'::jsonb);"))
        checks = json.loads(execute('test', 'SELECT json_build_object(' + ','.join(f"{literal(t)},(SELECT count(*) FROM {t})" for t in metadata['counts']) +
                                    ",'rlsMissing',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND (n.nspname='sequence_private' OR (n.nspname='public' AND c.relname LIKE 'seq\\_%')) AND NOT c.relrowsecurity)" +
                                    ",'deletedPresent',(SELECT count(*) FROM public.seq_workspaces w WHERE w.id IN (SELECT workspace_id FROM sequence_private.deletion_tombstones))" +
                                    ",'nonHeld',(SELECT count(*) FROM sequence_private.enrollments WHERE status IN ('Active','Waiting','Paused'))" + ');'))
        mismatches = {t: (checks[t], metadata['counts'][t]) for t in metadata['counts'] if t != 'public.seq_workspaces' and ledger == [] and checks[t] != metadata['counts'][t]}
        ok = checks['rlsMissing'] == 0 and checks['deletedPresent'] == 0 and checks['nonHeld'] == 0 and not mismatches
        elapsed = round(time.monotonic() - declared_start, 1)
        report.update({'applied': applied, 'finalized': json.loads(finalized), 'checks': checks, 'mismatches': mismatches, 'elapsedSeconds': elapsed,
                       'withinFourHours': elapsed <= 4 * 3600, 'ok': ok, 'expectedCountsNote': 'workspace counts shrink by ledger entries' if ledger else 'counts must match the backup'})
        details = json.dumps({k: v for k, v in report.items() if k != 'steps'} | {'steps': report['steps']}).replace("'", "''")
        # The drill record belongs to the operational log in development; the test project is rebuilt afterwards.
        execute('development', f"SELECT sequence_private.backup_record('{json.dumps({'kind': 'restore-drill', 'objectKey': key, 'sha256': pointer['sha256'] if key == pointer['key'] else hashlib.sha256(encrypted).hexdigest(), 'sizeBytes': len(encrypted), 'migrationVersion': metadata['migrationVersion'], 'details': json.loads(details)}).replace(chr(39), chr(39)*2)}'::jsonb);")
        print(json.dumps(report, indent=1))
        if not args.keep_restored:
            # Return the isolated test project to its empty, migrated state: remove every restored
            # workspace through the ledger function (the rebuild guard requires zero workspaces),
            # rebuild, drop the synthetic identity rows and migrate again.
            restored = execute('test', "SELECT coalesce(json_agg(json_build_object('workspaceId',id,'userId',owner_id)),'[]') FROM public.seq_workspaces;")
            execute('test', f"SELECT sequence_private.apply_deletion_ledger({literal(restored)}::jsonb);")
            rebuild_test('test', TARGETS['test'])
            ids = ','.join(literal(r.split(',')[0]) for r in rows)
            if ids:
                execute('test', f'DELETE FROM auth.users WHERE id IN ({ids});')
            migrate('test')
            print('test project returned to empty migrated state')
        if not ok:
            raise SystemExit('Restore drill validation failed; see report')
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
