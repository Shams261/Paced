"""S3-006 slice E integration cases: tenant health in status and the read-only operator health report."""
from test_database import check, role, assert_sql, deny, uid, W, E
from test_management import rpc


def integration():
    backup = role('sequence_backup')
    runtime = role('sequence_auth_runtime')
    check('status includes tenant-scoped health', role() + assert_sql(f"({rpc('status',{})}->'health'->>'heldCount')::int=1 AND ({rpc('status',{})}->'health'->>'uncertainSends')::int=0 AND ({rpc('status',{})}->'health'->>'executors')='none-registered' AND ({rpc('status',{})}->'health'->>'dueCount')::int=1") + deny(f"SELECT sequence_private.workspace_health('{W}')", '42501'))
    check('operator health is content-free, pilot-wide and readable by the backup role only', backup + assert_sql("(sequence_private.operator_health()->>'workspaces')::int=2 AND (sequence_private.operator_health()->>'heldEnrollments')::int=2 AND (sequence_private.operator_health()->'meters') IS NOT NULL AND jsonb_array_length(sequence_private.operator_health()->'pendingIdentityRemovals')=0 AND (sequence_private.operator_health()->'providerReadings'->0->>'meter')='egress_month_bytes'") + assert_sql("NOT (sequence_private.operator_health()::text ~ '@example.invalid') AND NOT (sequence_private.operator_health()::text ~ 'Example Person')") + 'RESET ROLE;' + role() + deny('SELECT sequence_private.operator_health()', '42501') + 'RESET ROLE;' + runtime + deny('SELECT sequence_private.operator_health()', '42501'))
    check('operator health counts uncertain outcomes and pending identity removals', backup + assert_sql("(sequence_private.operator_health()->>'unknownOutcomes')::int=1 AND jsonb_array_length(sequence_private.operator_health()->'pendingIdentityRemovals')=1 AND (sequence_private.operator_health()->>'uncertainSends')::int=0"), f"UPDATE sequence_private.logical_actions SET state='OutcomeUnknown' WHERE id='{uid(11)}'; INSERT INTO sequence_private.deletion_tombstones(workspace_id,user_id,request_id,result) VALUES('{uid(2,9)}','{uid(1,9)}','{uid(98)}','{{\"deleted\":true}}');")
