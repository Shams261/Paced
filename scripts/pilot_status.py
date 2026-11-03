"""Operator health check: reads the content-free health report with the read-only backup role and raises alerts."""
import argparse
import datetime
import json
import os
import subprocess

from backup import backup_password, connection_env, pg_bin
from database import TARGETS

WARN_PERCENT = 60
READING_REMINDER_DAYS = 5
READING_MAX_DAYS = 7
DENIAL_ALERT_5M = 20
DUE_DELAY_MINUTES = 30


def fetch(target):
    env = connection_env(target, backup_password(target))
    result = subprocess.run([pg_bin('psql'), '-X', '-w', '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', 'SELECT sequence_private.operator_health();'],
                            env=env, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError('health query failed: ' + result.stderr.replace(env['PGPASSWORD'], '[REDACTED]')[:500])
    return json.loads(result.stdout)


def evaluate(health, now=None):
    """Return (alerts, warnings) as lists of short reason strings; pure so it can be unit tested."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    alerts, warnings = [], []
    recovery = health.get('recovery', {})
    if recovery.get('state') == 'degraded':
        alerts.append('backup-older-than-24h')
    elif recovery.get('state') != 'ok':
        alerts.append('no-backup-recorded')
    for meter in health.get('meters', []):
        if meter.get('state') in ('deny', 'unverified'):
            alerts.append(f"meter-{meter.get('name')}-{meter.get('state')}")
        elif meter.get('state') == 'warn' or float(meter.get('percent', 0)) >= WARN_PERCENT:
            warnings.append(f"meter-{meter.get('name')}-warn")
    for reading in health.get('providerReadings', []):
        age = float(reading.get('ageDays', 0))
        if age > READING_MAX_DAYS:
            alerts.append(f"provider-reading-{reading.get('meter')}-stale")
        elif age > READING_REMINDER_DAYS:
            warnings.append(f"provider-reading-{reading.get('meter')}-refresh-soon")
    if not any(r.get('meter') == 'egress_month_bytes' for r in health.get('providerReadings', [])):
        alerts.append('provider-reading-egress_month_bytes-missing')
    if int(health.get('uncertainSends', 0)) > 0 or int(health.get('unknownOutcomes', 0)) > 0:
        alerts.append('uncertain-send-outcome')
    for pending in health.get('pendingIdentityRemovals', []):
        due = datetime.datetime.fromisoformat(pending['dueBy'].replace('Z', '+00:00'))
        (alerts if due < now else warnings).append('identity-removal-' + ('overdue' if due < now else 'pending'))
    if int(health.get('denialsLast5m', 0)) >= DENIAL_ALERT_5M:
        alerts.append('denials-last-5m-high')
    if int(health.get('unavailableLast5m', 0)) > 0:
        warnings.append('provider-unavailable-recently')
    oldest = health.get('oldestDueAt')
    if oldest:
        due = datetime.datetime.fromisoformat(oldest.replace('Z', '+00:00'))
        if due < now - datetime.timedelta(minutes=DUE_DELAY_MINUTES):
            warnings.append('due-work-delayed-no-executor')
    return alerts, warnings


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', required=True, choices=list(TARGETS))
    parser.add_argument('--strict', action='store_true', help='Exit 1 when any alert is raised (daily CI check)')
    parser.add_argument('--json', action='store_true', help='Print the full report')
    args = parser.parse_args(argv)
    health = fetch(args.target)
    alerts, warnings = evaluate(health)
    summary = {'target': args.target, 'generatedAt': health.get('generatedAt'), 'recovery': health.get('recovery', {}).get('state'),
               'growthAllowed': health.get('growthAllowed'), 'meters': {m['name']: f"{m['percent']}% {m['state']}" for m in health.get('meters', [])},
               'requestsToday': health.get('requestsToday'), 'workspaces': health.get('workspaces'), 'heldEnrollments': health.get('heldEnrollments'),
               'uncertainSends': health.get('uncertainSends'), 'pendingIdentityRemovals': len(health.get('pendingIdentityRemovals', [])),
               'alerts': alerts, 'warnings': warnings}
    print(json.dumps(health if args.json else summary, indent=1))
    if args.strict and alerts:
        raise SystemExit(f'ALERT: {", ".join(alerts)}')


if __name__ == '__main__':
    main()
