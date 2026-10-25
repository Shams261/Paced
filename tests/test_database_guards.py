import sys
from pathlib import Path
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from database import guard_test, connection, TARGETS, rebuild_test

class DatabaseGuardTests(unittest.TestCase):
    def test_test_target_requires_exact_confirmation(self):
        guard_test('test', TARGETS['test'])
        for target, ref in [('development', TARGETS['test']), ('test', TARGETS['development']), ('test', ''), ('production', TARGETS['test'])]:
            with self.assertRaises(ValueError): guard_test(target, ref)

    def test_arbitrary_connection_target_denied_before_secret_read(self):
        for target in ['production', 'postgres://attacker', '', '../development']:
            with self.assertRaises(ValueError): connection(target)

    def test_rebuild_refuses_marker_mismatch(self):
        with patch('database.execute', return_value='wrong-project') as query:
            with self.assertRaises(ValueError): rebuild_test('test', TARGETS['test'])
            self.assertEqual(query.call_count, 1)

    def test_rebuild_refuses_nonempty_database_before_ddl(self):
        with patch('database.execute', side_effect=[TARGETS['test'], '1']) as query:
            with self.assertRaises(ValueError): rebuild_test('test', TARGETS['test'])
            self.assertEqual(query.call_count, 2)

    def test_rebuild_never_connects_to_development(self):
        with patch('database.execute') as query:
            with self.assertRaises(ValueError): rebuild_test('development', TARGETS['development'])
            query.assert_not_called()
