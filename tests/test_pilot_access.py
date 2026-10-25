"""Operator admission guards; no provider connection or real identity is used."""
import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import pilot_access


class PilotAccessTests(unittest.TestCase):
    user = '11111111-1111-4111-8111-111111111111'
    project = pilot_access.TARGETS['test']

    def invoke(self, *, action='approve', marker=None, verified=True,
               google=True, email='owner@example.invalid', confirmation=None):
        identity = json.dumps(dict(userId=self.user, email=email,
                                   verified=verified, google=google))
        args = ['pilot_access', action, '--target', 'test', '--user', self.user,
                '--confirm-project', self.project,
                '--confirm-email', confirmation or email]
        with patch.object(sys, 'argv', args), patch.object(
                pilot_access, 'execute', side_effect=[marker or self.project, identity, 'ok']) as execute:
            with contextlib.redirect_stdout(io.StringIO()):
                try:
                    pilot_access.main()
                finally:
                    self.calls = execute.call_args_list

    def test_wrong_environment_never_inspects_or_mutates(self):
        with self.assertRaises(ValueError):
            self.invoke(marker='wrong-project')
        self.assertEqual(len(self.calls), 1)

    def test_unverified_or_non_google_identity_never_mutates(self):
        for values in [dict(verified=False), dict(google=False)]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.invoke(**values)
            self.assertEqual(len(self.calls), 2)

    def test_wrong_email_confirmation_never_mutates(self):
        with self.assertRaises(ValueError):
            self.invoke(confirmation='different@example.invalid')
        self.assertEqual(len(self.calls), 2)

    def test_inspection_is_read_only(self):
        self.invoke(action='inspect')
        self.assertEqual(len(self.calls), 2)

    def test_identity_removal_needs_email_confirmation_and_uses_operator_function(self):
        with self.assertRaises(ValueError):
            self.invoke(action='delete-identity', confirmation='different@example.invalid')
        self.assertEqual(len(self.calls), 2)
        self.invoke(action='delete-identity', google=False)
        sql = self.calls[-1].args[1]
        self.assertTrue(sql.startswith('BEGIN;') and sql.endswith('COMMIT;'))
        self.assertIn('operator_remove_identity', sql)
        self.assertNotIn('operator_admission', sql)

    def test_mutation_rechecks_identity_inside_locked_transaction(self):
        self.invoke(email="o'neal@example.invalid")
        sql = self.calls[-1].args[1]
        self.assertTrue(sql.startswith('BEGIN;'))
        self.assertIn('FOR UPDATE', sql)
        self.assertIn("email='o''neal@example.invalid'", sql)
        self.assertIn('operator_admission', sql)
        self.assertTrue(sql.endswith('COMMIT;'))


if __name__ == '__main__':
    unittest.main()
