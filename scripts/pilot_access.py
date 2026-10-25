"""Owner-only pilot admission and post-deletion identity removal. Uses guarded operator credentials, never runtime credentials."""
import argparse
import json
import uuid
from database import TARGETS, execute


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['inspect', 'approve', 'revoke', 'delete-identity'])
    parser.add_argument('--target', required=True, choices=['development', 'test'])
    parser.add_argument('--user', required=True, type=uuid.UUID)
    parser.add_argument('--confirm-project')
    parser.add_argument('--confirm-email')
    args = parser.parse_args()
    marker = execute(args.target, 'SELECT project_ref FROM sequence_meta.environment;')
    if marker != TARGETS[args.target]:
        raise ValueError('Environment marker mismatch')
    user = str(args.user)
    # Inspection is intentionally operator-facing, not a technical log.
    raw = execute(args.target, f"SELECT jsonb_build_object('userId',u.id,'email',u.email,'verified',u.email_confirmed_at IS NOT NULL,'google',EXISTS(SELECT 1 FROM auth.identities i WHERE i.user_id=u.id AND i.provider='google')) FROM auth.users u WHERE u.id='{user}';")
    if not raw:
        raise ValueError('Identity not found')
    identity = json.loads(raw)
    if args.action == 'inspect':
        print(json.dumps({'project': TARGETS[args.target], **identity}, indent=2))
        return
    if args.confirm_project != TARGETS[args.target] or args.confirm_email != identity['email']:
        raise ValueError('Review inspect output and confirm the exact project and email')
    if args.action == 'delete-identity':
        # Only after the user's own recorded deletion; the function refuses while a workspace exists.
        execute(args.target, f"BEGIN; SELECT id FROM auth.users WHERE id='{user}' FOR UPDATE; SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM auth.users WHERE id='{user}' AND email={literal(args.confirm_email)}) THEN 1 ELSE 0 END; SELECT sequence_private.operator_remove_identity('{user}','{uuid.uuid4()}'); COMMIT;")
        print(f'identity removal committed for {user} in {TARGETS[args.target]}')
        return
    if not identity['verified'] or not identity['google']:
        raise ValueError('Verified Google identity required')
    approved = 'true' if args.action == 'approve' else 'false'
    # Recheck the reviewed identity inside the transaction; no stale email approval.
    execute(args.target, f"BEGIN; SELECT id FROM auth.users WHERE id='{user}' FOR UPDATE; SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM auth.users WHERE id='{user}' AND email={literal(args.confirm_email)}) THEN 1 ELSE 0 END; SELECT sequence_private.operator_admission('{user}',{approved},'{uuid.uuid4()}'); COMMIT;")
    print(f'{args.action} committed for {user} in {TARGETS[args.target]}')


if __name__ == '__main__':
    main()
