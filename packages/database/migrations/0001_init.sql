-- gen_random_uuid() is built in on PostgreSQL 13+, but pgcrypto also provides digest() for
-- content hashing in later migrations. No domain tables here; those arrive in WP1.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
