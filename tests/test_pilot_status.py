"""Alert evaluation for the operator health check; no database is used."""
import datetime
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import pilot_status

NOW = datetime.datetime(2026, 11, 3, 12, 0, tzinfo=datetime.timezone.utc)


def healthy():
    return {'recovery': {'state': 'ok'},
            'meters': [{'name': 'database_bytes', 'percent': 5.6, 'state': 'ok'}, {'name': 'requests_day', 'percent': 0, 'state': 'ok'},
                       {'name': 'egress_month_bytes', 'percent': 0, 'state': 'ok'}],
            'providerReadings': [{'meter': 'egress_month_bytes', 'ageDays': 1.0}], 'uncertainSends': 0, 'unknownOutcomes': 0,
            'pendingIdentityRemovals': [], 'denialsLast5m': 0, 'unavailableLast5m': 0, 'oldestDueAt': None}


class EvaluateTests(unittest.TestCase):
    def test_healthy_report_has_no_alerts(self):
        self.assertEqual(pilot_status.evaluate(healthy(), NOW), ([], []))

    def test_backup_quota_and_reading_alerts(self):
        h = healthy()
        h['recovery'] = {'state': 'degraded'}
        h['meters'][0] = {'name': 'database_bytes', 'percent': 72, 'state': 'deny'}
        h['meters'][1] = {'name': 'requests_day', 'percent': 61, 'state': 'warn'}
        h['providerReadings'] = [{'meter': 'egress_month_bytes', 'ageDays': 8}]
        alerts, warnings = pilot_status.evaluate(h, NOW)
        self.assertEqual(alerts, ['backup-older-than-24h', 'meter-database_bytes-deny', 'provider-reading-egress_month_bytes-stale'])
        self.assertEqual(warnings, ['meter-requests_day-warn'])

    def test_missing_reading_uncertain_send_and_identity_due(self):
        h = healthy()
        h['providerReadings'] = []
        h['uncertainSends'] = 1
        h['pendingIdentityRemovals'] = [{'workspaceId': 'w', 'deletedAt': 'x', 'dueBy': '2026-11-01T00:00:00+00:00'},
                                        {'workspaceId': 'v', 'deletedAt': 'y', 'dueBy': '2026-11-09T00:00:00+00:00'}]
        h['denialsLast5m'] = 25
        h['unavailableLast5m'] = 1
        h['oldestDueAt'] = '2026-11-03T10:00:00+00:00'
        alerts, warnings = pilot_status.evaluate(h, NOW)
        self.assertEqual(alerts, ['provider-reading-egress_month_bytes-missing', 'uncertain-send-outcome', 'identity-removal-overdue', 'denials-last-5m-high'])
        self.assertEqual(warnings, ['identity-removal-pending', 'provider-unavailable-recently', 'due-work-delayed-no-executor'])

    def test_reminder_before_reading_expires(self):
        h = healthy()
        h['providerReadings'] = [{'meter': 'egress_month_bytes', 'ageDays': 6}]
        self.assertEqual(pilot_status.evaluate(h, NOW), ([], ['provider-reading-egress_month_bytes-refresh-soon']))


if __name__ == '__main__':
    unittest.main()
