-- Defense in depth for the internal allowlist; only owner-controlled provisioning writes it.
ALTER TABLE sequence_private.access_allowlist ENABLE ROW LEVEL SECURITY;
