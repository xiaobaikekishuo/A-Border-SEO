-- Hosted execution is deliberately separate from desktop lease receipts.
-- A server check must never turn an older/offline client's status into success.
CREATE TABLE hosted_receipt (
  product_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('account', 'device')),
  subject_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  installation_id TEXT,
  token_hash TEXT,
  revision INTEGER NOT NULL,
  desktop_version TEXT,
  backend_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('effective', 'blocked', 'draining', 'failed')),
  code TEXT,
  checked_at INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY(product_id, scope, subject_id),
  FOREIGN KEY(product_id, account_id) REFERENCES account(product_id, id),
  FOREIGN KEY(product_id, installation_id) REFERENCES device(product_id, installation_id)
) STRICT;
