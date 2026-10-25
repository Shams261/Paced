"""Operator quota meters: show the computed status or record a provider dashboard reading."""
import argparse
import json
import uuid
from database import TARGETS, execute

METERS = ('database_bytes', 'requests_day', 'egress_month_bytes')
MAX_VALUE = 10 ** 13


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['show', 'set'])
    parser.add_argument('--target', required=True, choices=['development', 'test'])
    parser.add_argument('--meter', choices=METERS)
    parser.add_argument('--value', type=int)
    parser.add_argument('--note', default='')
    args = parser.parse_args()
    marker = execute(args.target, 'SELECT project_ref FROM sequence_meta.environment;')
    if marker != TARGETS[args.target]:
        raise ValueError('Environment marker mismatch')
    if args.action == 'show':
        print(json.dumps({'project': marker, 'status': json.loads(execute(args.target, 'SELECT sequence_private.quota_status();'))}, indent=2))
        return
    if args.meter is None or args.value is None:
        raise ValueError('set requires --meter and --value from the provider dashboard')
    if args.value < 0 or args.value > MAX_VALUE:
        raise ValueError('Reading out of range')
    if len(args.note) > 200:
        raise ValueError('Note too long')
    execute(args.target, f"BEGIN; INSERT INTO sequence_private.provider_readings(meter,value,read_at,note) VALUES({literal(args.meter)},{args.value},now(),{literal(args.note)}) ON CONFLICT(meter) DO UPDATE SET value=excluded.value,read_at=now(),note=excluded.note; COMMIT;")
    print(f'recorded {args.meter}={args.value} in {marker} (reading {uuid.uuid4()})')


if __name__ == '__main__':
    main()
