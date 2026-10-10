-- Logins are stored lowercased (GitHub logins are case-insensitive) and bound to
-- the account's numeric id on first push, since a renamed login can be re-registered.
CREATE TABLE owners (
  login TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE versions (
  owner TEXT NOT NULL REFERENCES owners (login),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  hash TEXT NOT NULL,
  document TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner, name, version)
);
