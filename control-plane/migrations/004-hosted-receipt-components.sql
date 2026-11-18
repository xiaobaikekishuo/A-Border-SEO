-- Each execution component owns its receipt. An HTTP session cannot overwrite
-- a worker which is still draining. Unattributed historical receipts stay legacy.
CREATE TABLE hosted_receipt_components (
  product_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('account', 'device')),
  subject_id TEXT NOT NULL,
  component TEXT NOT NULL CHECK (component IN ('http_session', 'http_api', 'content_worker', 'ordinary_worker', 'legacy')),
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
  PRIMARY KEY(product_id, scope, subject_id, component),
  FOREIGN KEY(product_id, account_id) REFERENCES account(product_id, id),
  FOREIGN KEY(product_id, installation_id) REFERENCES device(product_id, installation_id)
) STRICT;
INSERT INTO hosted_receipt_components
  SELECT product_id, scope, subject_id, 'legacy', account_id, installation_id,
    token_hash, revision, desktop_version, backend_version, status, code, checked_at, valid_until, at
  FROM hosted_receipt;
DROP TABLE hosted_receipt;
ALTER TABLE hosted_receipt_components RENAME TO hosted_receipt;
