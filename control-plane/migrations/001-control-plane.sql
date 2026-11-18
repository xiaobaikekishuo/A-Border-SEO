CREATE TABLE admin (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL
) STRICT;
CREATE TABLE admin_session (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES admin(username) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX admin_session_expiry ON admin_session(expires_at);

CREATE TABLE product (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
) STRICT;
INSERT INTO product (id, name) VALUES ('a-border-seo', 'A-Border SEO');

CREATE TABLE account (
  product_id TEXT NOT NULL REFERENCES product(id),
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  expires_at INTEGER,
  device_limit INTEGER NOT NULL CHECK (device_limit BETWEEN 1 AND 1000),
  features TEXT NOT NULL,
  PRIMARY KEY(product_id, id)
) STRICT;

CREATE TABLE device (
  product_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  group_name TEXT NOT NULL DEFAULT '',
  last_seen_at INTEGER NOT NULL,
  desktop_version TEXT NOT NULL,
  backend_version TEXT,
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  receipt_sequence INTEGER,
  receipt_revision INTEGER,
  receipt_status TEXT,
  receipt_code TEXT,
  receipt_at INTEGER,
  PRIMARY KEY(product_id, installation_id),
  FOREIGN KEY(product_id, account_id) REFERENCES account(product_id, id)
) STRICT;
CREATE INDEX device_account ON device(product_id, account_id, revoked);

CREATE TABLE activation (
  code_hash TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  target_installation_id TEXT,
  installation_id TEXT,
  consumed_at INTEGER,
  FOREIGN KEY(product_id, account_id) REFERENCES account(product_id, id)
) STRICT;
CREATE INDEX activation_expiry ON activation(expires_at);

CREATE TABLE policy (
  product_id TEXT NOT NULL REFERENCES product(id),
  scope TEXT NOT NULL CHECK (scope IN ('product', 'account', 'device', 'group')),
  scope_id TEXT NOT NULL,
  disabled INTEGER NOT NULL CHECK (disabled IN (0, 1)),
  maintenance INTEGER NOT NULL CHECK (maintenance IN (0, 1)),
  start_at INTEGER,
  end_at INTEGER,
  message TEXT NOT NULL,
  features TEXT NOT NULL,
  PRIMARY KEY(product_id, scope, scope_id)
) STRICT;

CREATE TABLE release (
  product_id TEXT NOT NULL REFERENCES product(id),
  version TEXT NOT NULL,
  config TEXT NOT NULL,
  verified_at INTEGER,
  PRIMARY KEY(product_id, version)
) STRICT;

CREATE TABLE issued_lease (
  product_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  release_version TEXT,
  PRIMARY KEY(product_id, installation_id, sequence),
  FOREIGN KEY(product_id, installation_id) REFERENCES device(product_id, installation_id)
) STRICT;

CREATE TABLE rollout_failure (
  product_id TEXT NOT NULL,
  release_version TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  code TEXT NOT NULL,
  PRIMARY KEY(product_id, release_version, installation_id),
  FOREIGN KEY(product_id, installation_id) REFERENCES device(product_id, installation_id)
) STRICT;
CREATE TABLE rollout_success (
  product_id TEXT NOT NULL,
  release_version TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY(product_id, release_version, installation_id),
  FOREIGN KEY(product_id, installation_id) REFERENCES device(product_id, installation_id)
) STRICT;

CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES product(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  scope TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX audit_product ON audit(product_id, id DESC);
CREATE INDEX audit_receipt_scope ON audit(product_id, scope, reason)
  WHERE action = 'device_receipt';
