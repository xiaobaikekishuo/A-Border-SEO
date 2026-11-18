ALTER TABLE account ADD COLUMN username TEXT;
ALTER TABLE account ADD COLUMN password_hash TEXT;
ALTER TABLE account ADD COLUMN registered_at INTEGER;
ALTER TABLE account ADD COLUMN approved_at INTEGER;
ALTER TABLE account ADD COLUMN registration_installation_id TEXT;
CREATE UNIQUE INDEX account_username ON account(product_id, username) WHERE username IS NOT NULL;
