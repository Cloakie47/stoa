-- Stoa Telegram bot — audit log for security-sensitive actions.
-- Run: wrangler d1 execute stoa-bot-db --local --file=migrations/0004_audit_log.sql
--
-- IDEMPOTENT: uses IF NOT EXISTS on both the table and the index, so this
-- migration can be re-applied safely without erroring.

CREATE TABLE IF NOT EXISTS audit_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id    INTEGER NOT NULL,
  action              TEXT NOT NULL,           -- e.g. 'export_key'
  metadata            TEXT,                    -- JSON; NEVER include secrets
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(telegram_user_id);
