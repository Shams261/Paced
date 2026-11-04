"""Daily encrypted backup to R2 using the SELECT-only backup role. Runs in CI or locally; prints no secrets."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

from database import HOST, ROOT, TARGETS
from r2 import R2Client

ACCOUNT_ID = '319119b10a3906fd76f1c11a2abddbe0'
BUCKET = 'paced-backups'
BACKUP_KEY_FPR = '5DE5637F846663FEEA765CD1474D80DE70A9D191'
LEDGER_KEY_FPR = 'BD2C79D92E2424AA302358E98F8830F4F7BB582D'
KEEP_DAYS = 7
EXCLUDED_TABLES = ('sequence_private.deletion_tombstones', 'sequence_private.auth_sessions',
                   'sequence_private.login_transactions', 'sequence_private.auth_rate_limits',
                   'sequence_private.executors', 'sequence_private.pairing_codes')
COUNT_TABLES = ('public.seq_workspaces', 'public.seq_prospects', 'public.seq_lists', 'public.seq_campaigns',
                'sequence_private.enrollments', 'sequence_private.logical_actions', 'sequence_private.approvals')


def pg_bin(name):
    for base in [os.environ.get('PG_BIN'), '/opt/homebrew/opt/libpq/bin', '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/18/bin']:
        if base and (Path(base) / name).exists():
            return str(Path(base) / name)
    found = shutil.which(name)
    if not found:
        raise ValueError(f'{name} is required (PostgreSQL 17 or newer client tools)')
    return found


def backup_password(target):
    value = os.environ.get('PACED_BACKUP_DB_PASSWORD')
    if not value:
        path = ROOT / '.local' / f'db-backup-{target}-password.txt'
        value = path.read_text().strip() if path.exists() else ''
    if not value:
        raise ValueError('Backup role password is missing (PACED_BACKUP_DB_PASSWORD or ignored local file)')
    return value


def r2_credentials():
    key, secret = os.environ.get('R2_ACCESS_KEY_ID'), os.environ.get('R2_SECRET_ACCESS_KEY')
    if not (key and secret):
        path = ROOT / '.local' / 'r2-credentials.json'
        if path.exists():
            data = json.loads(path.read_text())
            key, secret = data.get('accessKeyId'), data.get('secretAccessKey')
    if not (key and secret):
        raise ValueError('R2 credentials are missing (R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY or ignored local file)')
    return key, secret


def connection_env(target, password):
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    env.update(PGHOST=HOST, PGPORT='5432', PGUSER=f'sequence_backup.{TARGETS[target]}', PGDATABASE='postgres',
               PGPASSWORD=password, PGSSLMODE='verify-full', PGSSLROOTCERT=str(ROOT / 'supabase/supabase-ca.crt'),
               PGCONNECT_TIMEOUT='15')
    return env


def run(args, env, input_text=None, timeout=600):
    result = subprocess.run(args, env=env, input=input_text, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        message = result.stderr
        for secret in [env.get('PGPASSWORD')]:
            if secret:
                message = message.replace(secret, '[REDACTED]')
        raise RuntimeError(f'{Path(args[0]).name} failed: {message.strip()[:2000]}')
    return result.stdout


def psql(env, sql):
    return run([pg_bin('psql'), '-X', '-w', '-v', 'ON_ERROR_STOP=1', '-qAt'], env, input_text=sql).strip()


def gpg_home(keys_dir):
    home = tempfile.mkdtemp(prefix='paced-gpg-')
    os.chmod(home, 0o700)
    env = {**os.environ, 'GNUPGHOME': home}
    for name in ('backup.asc', 'ledger.asc'):
        run(['gpg', '--batch', '--quiet', '--import', str(keys_dir / name)], env)
    listed = run(['gpg', '--batch', '--with-colons', '--list-keys'], env)
    fingerprints = [line.split(':')[9] for line in listed.splitlines() if line.startswith('fpr:')]
    if BACKUP_KEY_FPR not in fingerprints or LEDGER_KEY_FPR not in fingerprints:
        raise ValueError('Expected backup and ledger public keys were not found in the repository key files')
    return env


def encrypt(gpg_env, fingerprint, source, destination):
    run(['gpg', '--batch', '--quiet', '--yes', '--trust-model', 'always', '--recipient', fingerprint,
         '--output', str(destination), '--encrypt', str(source)], gpg_env)
    return Path(destination).read_bytes()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def stamp_of(key):
    name = key.rsplit('/', 1)[-1]
    try:
        return datetime.datetime.strptime(name[:16], '%Y%m%dT%H%M%SZ').replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        return None


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', required=True, choices=list(TARGETS))
    parser.add_argument('--keep-local', help='Directory to keep the plaintext artifacts in (default: temporary, deleted)')
    parser.add_argument('--local-only', action='store_true', help='Build and encrypt only; no upload, retention or backup log entry')
    args = parser.parse_args(argv)
    started = datetime.datetime.now(datetime.timezone.utc)
    env = connection_env(args.target, backup_password(args.target))
    client = None
    if not args.local_only:
        access_key, secret_key = r2_credentials()
        client = R2Client(os.environ.get('R2_ACCOUNT_ID', ACCOUNT_ID), os.environ.get('R2_BUCKET', BUCKET), access_key, secret_key)
    # Preflight: exact project marker, role identity and schema version; no data read yet.
    marker, user, version = psql(env, "SELECT project_ref FROM sequence_meta.environment; SELECT current_user; SELECT max(version) FROM sequence_meta.migrations;").split('\n')
    if marker != TARGETS[args.target] or user != 'sequence_backup':
        raise ValueError('Environment marker or role mismatch; refusing to back up')
    counts = json.loads(psql(env, 'SELECT json_build_object(' + ','.join(f"'{t}',(SELECT count(*) FROM {t})" for t in COUNT_TABLES) + ');'))
    work = Path(args.keep_local) if args.keep_local else Path(tempfile.mkdtemp(prefix='paced-backup-'))
    work.mkdir(parents=True, exist_ok=True)
    gpg_env = gpg_home(ROOT / 'supabase/backup-keys')
    try:
        dump = work / 'data.dump'
        run([pg_bin('pg_dump'), '-Fc', '--data-only', '--no-owner', '--no-acl', '--enable-row-security', '-t', 'public.seq_*', '-t', 'sequence_private.*',
             *sum((['-T', t] for t in EXCLUDED_TABLES), []), '-f', str(dump), 'postgres'], env, timeout=1800)
        (work / 'identities.csv').write_text(run([pg_bin('psql'), '-X', '-w', '-v', 'ON_ERROR_STOP=1', '-qAt', '-c',
            'COPY (SELECT * FROM sequence_private.backup_identities()) TO STDOUT WITH CSV HEADER'], env))
        ledger_lines = run([pg_bin('psql'), '-X', '-w', '-v', 'ON_ERROR_STOP=1', '-qAt', '-c',
            "COPY (SELECT json_build_object('workspaceId',workspace_id,'userId',user_id,'requestId',request_id,'deletedAt',deleted_at,'backupCutoff',backup_cutoff,'identityRemovedAt',identity_removed_at) FROM sequence_private.deletion_tombstones ORDER BY deleted_at) TO STDOUT"], env)
        stamp = started.strftime('%Y%m%dT%H%M%SZ')
        metadata = {'formatVersion': 'paced-backup-1', 'generatedAt': started.isoformat(), 'projectRef': marker, 'target': args.target,
                    'migrationVersion': version, 'dumpSha256': sha256(dump.read_bytes()), 'dumpBytes': dump.stat().st_size,
                    'excludedTables': list(EXCLUDED_TABLES), 'counts': counts, 'ledgerEntries': len(ledger_lines.splitlines()),
                    'pgDumpVersion': run([pg_bin('pg_dump'), '--version'], env).strip()}
        (work / 'metadata.json').write_text(json.dumps(metadata, indent=1))
        archive = work / f'{stamp}.tar'
        with tarfile.open(archive, 'w') as tar:
            for name in ('metadata.json', 'identities.csv', 'data.dump'):
                tar.add(work / name, arcname=name)
        encrypted = encrypt(gpg_env, BACKUP_KEY_FPR, archive, work / f'{stamp}.tar.gpg')
        ledger_path = work / f'{stamp}.jsonl'
        ledger_path.write_text(ledger_lines)
        ledger_encrypted = encrypt(gpg_env, LEDGER_KEY_FPR, ledger_path, work / f'{stamp}.jsonl.gpg')
        backup_key, ledger_key = f'backups/{stamp}.tar.gpg', f'ledger/{stamp}.jsonl.gpg'
        digest = sha256(encrypted)
        if args.local_only:
            print(json.dumps({'ok': True, 'localOnly': True, 'target': args.target, 'workDir': str(work), 'sha256': digest, 'sizeBytes': len(encrypted),
                              'migrationVersion': version, 'counts': counts, 'ledgerEntries': metadata['ledgerEntries'], 'dumpBytes': metadata['dumpBytes']}, indent=1))
            return
        client.put_object(backup_key, encrypted)
        client.put_object(ledger_key, ledger_encrypted)
        pointer = {'key': backup_key, 'sha256': digest, 'sizeBytes': len(encrypted), 'generatedAt': metadata['generatedAt'],
                   'migrationVersion': version, 'projectRef': marker, 'ledgerKey': ledger_key, 'ledgerSha256': sha256(ledger_encrypted)}
        client.put_object('backups/latest.json', json.dumps(pointer).encode(), 'application/json')
        removed = []
        for key, _, _ in client.list_objects('backups/'):
            when = stamp_of(key)
            if when and when < started - datetime.timedelta(days=KEEP_DAYS):
                client.delete_object(key)
                removed.append(key)
        record = {'kind': 'backup', 'objectKey': backup_key, 'sha256': digest, 'sizeBytes': len(encrypted), 'migrationVersion': version,
                  'details': {'ledgerKey': ledger_key, 'counts': counts, 'ledgerEntries': metadata['ledgerEntries'], 'removed': removed,
                              'durationSeconds': round((datetime.datetime.now(datetime.timezone.utc) - started).total_seconds(), 1)}}
        log_id = psql(env, f"SELECT sequence_private.backup_record('{json.dumps(record).replace(chr(39), chr(39)*2)}'::jsonb);")
        print(json.dumps({'ok': True, 'target': args.target, 'backupKey': backup_key, 'ledgerKey': ledger_key, 'sha256': digest,
                          'sizeBytes': len(encrypted), 'migrationVersion': version, 'counts': counts, 'removed': removed, 'backupLogId': log_id}, indent=1))
    finally:
        shutil.rmtree(gpg_env['GNUPGHOME'], ignore_errors=True)
        if not args.keep_local:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
