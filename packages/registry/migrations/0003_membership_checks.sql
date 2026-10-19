-- Org memberships are a snapshot taken at `typedhook login`; publishing for an
-- org needs a recent one, so a member removed from the org loses access.
ALTER TABLE memberships ADD COLUMN checked_at TEXT;
