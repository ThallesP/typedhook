-- Publishing from a laptop: `typedhook login` goes through GitHub's device flow
-- and gets a registry token. Only its hash is stored.
CREATE TABLE tokens (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  login TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT
);

-- The GitHub organizations a user could publish for, as of their last login.
CREATE TABLE memberships (
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  org_login TEXT NOT NULL,
  PRIMARY KEY (user_id, org_id)
);

-- One row per owner/name for listing and search, updated on every publish.
CREATE TABLE registries (
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  latest TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner, name)
);

-- bump and changes compare a version with the one before it (JSON from diffDocuments).
ALTER TABLE versions ADD COLUMN bump TEXT;
ALTER TABLE versions ADD COLUMN changes TEXT;
ALTER TABLE versions ADD COLUMN published_by TEXT;
