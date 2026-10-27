CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE INDEX webhook_deliveries_expires ON webhook_deliveries(expires_at);
