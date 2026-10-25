"""Operator meter guards; no provider connection is used."""
import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import pilot_meters


class PilotMetersTests(unittest.TestCase):
    project = pilot_meters.TARGETS['test']

    def invoke(self, *argv, marker=None, result='{"growthAllowed": true}'):
        args = ['pilot_meters', *argv, '--target', 'test']
        with patch.object(sys, 'argv', args), patch.object(
                pilot_meters, 'execute', side_effect=[marker or self.project, result]) as execute:
            with contextlib.redirect_stdout(io.StringIO()):
                try:
                    pilot_meters.main()
                finally:
                    self.calls = execute.call_args_list

    def test_wrong_environment_never_reads_or_writes(self):
        with self.assertRaises(ValueError):
            self.invoke('show', marker='wrong-project')
        self.assertEqual(len(self.calls), 1)

    def test_show_is_read_only(self):
        self.invoke('show')
        self.assertEqual(len(self.calls), 2)
        self.assertIn('quota_status', self.calls[-1].args[1])

    def test_set_requires_meter_and_bounded_value(self):
        with self.assertRaises(ValueError):
            self.invoke('set', '--meter', 'egress_month_bytes')
        self.assertEqual(len(self.calls), 1)
        with self.assertRaises(ValueError):
            self.invoke('set', '--meter', 'egress_month_bytes', '--value', '-1')
        self.assertEqual(len(self.calls), 1)
        with self.assertRaises(SystemExit):
            self.invoke('set', '--meter', 'auth_sessions', '--value', '1')

    def test_set_upserts_quoted_reading_in_transaction(self):
        self.invoke('set', '--meter', 'egress_month_bytes', '--value', '1234', '--note', "dashboard 'usage' page")
        sql = self.calls[-1].args[1]
        self.assertTrue(sql.startswith('BEGIN;') and sql.endswith('COMMIT;'))
        self.assertIn("'egress_month_bytes',1234", sql)
        self.assertIn("'dashboard ''usage'' page'", sql)
        self.assertIn('ON CONFLICT(meter)', sql)


if __name__ == '__main__':
    unittest.main()
