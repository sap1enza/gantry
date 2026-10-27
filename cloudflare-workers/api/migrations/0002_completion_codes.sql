ALTER TABLE oauth_states ADD COLUMN device_id TEXT;
ALTER TABLE email_links ADD COLUMN device_id TEXT;

CREATE TABLE completion_codes (
  code_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX completion_codes_expires ON completion_codes(expires_at);
