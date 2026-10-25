-- Record the authenticated database principal for new audit records.
-- Historical rows remain NULL: their actor cannot be reconstructed reliably.
ALTER TABLE sequence_private.auth_audit ADD COLUMN database_principal text;
ALTER TABLE sequence_private.auth_audit ALTER COLUMN database_principal SET DEFAULT session_user;
COMMENT ON COLUMN sequence_private.auth_audit.database_principal IS
 'Authenticated database login principal, not a claimed human identity. Historical rows may be unknown.';
