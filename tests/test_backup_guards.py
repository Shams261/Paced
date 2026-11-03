"""Backup script guards; no database, R2 or gpg is used."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import backup


class BackupGuardTests(unittest.TestCase):
    def test_missing_password_or_credentials_stop_before_any_connection(self):
        with patch.dict(os.environ, {'PACED_BACKUP_DB_PASSWORD': ''}, clear=False), patch.object(backup.Path, 'exists', return_value=False):
            with self.assertRaises(ValueError):
                backup.backup_password('development')
            with patch.dict(os.environ, {'R2_ACCESS_KEY_ID': '', 'R2_SECRET_ACCESS_KEY': ''}):
                with self.assertRaises(ValueError):
                    backup.r2_credentials()

    def test_marker_or_role_mismatch_refuses_before_dumping(self):
        with patch.dict(os.environ, {'PACED_BACKUP_DB_PASSWORD': 'x', 'R2_ACCESS_KEY_ID': 'k', 'R2_SECRET_ACCESS_KEY': 's'}), \
                patch.object(backup, 'psql', return_value='wrong-project\nsequence_backup\nv1') as psql, \
                patch.object(backup, 'run') as run:
            with self.assertRaises(ValueError):
                backup.main(['--target', 'development'])
            self.assertEqual(psql.call_count, 1)
            run.assert_not_called()

    def test_connection_env_uses_backup_role_verified_tls_and_no_inherited_pg_vars(self):
        with patch.dict(os.environ, {'PGPASSWORD': 'leak', 'PGHOST': 'leak'}):
            env = backup.connection_env('test', 'pw')
        self.assertEqual(env['PGUSER'], 'sequence_backup.' + backup.TARGETS['test'])
        self.assertEqual(env['PGSSLMODE'], 'verify-full')
        self.assertTrue(env['PGSSLROOTCERT'].endswith('supabase/supabase-ca.crt'))
        self.assertEqual(env['PGPASSWORD'], 'pw')

    def test_retention_parses_timestamps_from_keys(self):
        self.assertIsNotNone(backup.stamp_of('backups/20261103T031500Z.tar.gpg'))
        self.assertIsNone(backup.stamp_of('backups/latest.json'))


if __name__ == '__main__':
    unittest.main()
