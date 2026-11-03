"""Operator setup for the SELECT-only backup role: enable login with a generated password, then verify its limits."""
import argparse
import os
from pathlib import Path
import secrets
import subprocess

from database import HOST, ROOT, TARGETS, execute


def password_path(target):
    return ROOT / '.local' / f'db-backup-{target}-password.txt'


def enable(target):
    marker = execute(target, 'SELECT project_ref FROM sequence_meta.environment;')
    if marker != TARGETS[target]:
        raise ValueError('Environment marker mismatch')
    password = secrets.token_urlsafe(36)
    path = password_path(target)
    path.parent.mkdir(exist_ok=True)
    with open(path, 'w', opener=lambda p, f: os.open(p, f, 0o600)) as handle:
        handle.write(password + '\n')
    os.chmod(path, 0o600)
    # Only LOGIN and the password change here; the migration already created the role without privileges,
    # and Supabase rejects redundant attribute changes from the non-superuser operator.
    execute(target, f"ALTER ROLE sequence_backup WITH LOGIN PASSWORD '{password}';")
    print(f'backup role login enabled for {marker}; password stored only in {path.relative_to(ROOT)}')


def verify(target):
    path = password_path(target)
    if not path.exists():
        raise ValueError('Run enable first')
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    env.update(PGPASSWORD=path.read_text().strip(), PGSSLMODE='verify-full', PGSSLROOTCERT=str(ROOT / 'supabase/supabase-ca.crt'), PGCONNECT_TIMEOUT='15')
    args = ['psql', '-X', '-w', '-v', 'ON_ERROR_STOP=0', '-qAt', '-h', HOST, '-p', '5432', '-U', f'sequence_backup.{TARGETS[target]}', '-d', 'postgres']
    sql = """SELECT 'user='||current_user;
SELECT 'prospects='||count(*) FROM public.seq_prospects;
SELECT 'identities='||count(*) FROM sequence_private.backup_identities();
SELECT 'sessions-denied='||(SELECT count(*) FROM sequence_private.auth_sessions);
INSERT INTO sequence_private.provider_readings(meter,value) VALUES('database_bytes',1);
UPDATE public.seq_prospects SET display_name='x';
SELECT 'done';"""
    result = subprocess.run(args, input=sql, env=env, capture_output=True, text=True, timeout=60)
    print(result.stdout.strip())
    errors = result.stderr.replace(env['PGPASSWORD'], '[REDACTED]')
    denied = errors.count('permission denied')
    print(f'write/read-denied errors observed: {denied} (expected 3: sessions read, insert, update)')
    if 'done' not in result.stdout or denied != 3:
        raise SystemExit('Backup role verification did not match the expected read-only behaviour')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['enable', 'verify'])
    parser.add_argument('--target', required=True, choices=['development', 'test'])
    args = parser.parse_args()
    (enable if args.action == 'enable' else verify)(args.target)


if __name__ == '__main__':
    main()
