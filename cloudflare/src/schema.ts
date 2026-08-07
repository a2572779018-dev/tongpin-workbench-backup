export const DATABASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('member', 'boss', 'admin')),
    status TEXT NOT NULL CHECK (status IN ('pending_email', 'pending_approval', 'active', 'disabled')),
    avatar_seed INTEGER NOT NULL,
    avatar_version INTEGER NOT NULL DEFAULT 0,
    avatar_data_url TEXT,
    email_verified_at TEXT,
    last_login_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'done')),
    priority TEXT NOT NULL CHECK (priority IN ('p0', 'p1', 'p2', 'p3', 'p4')),
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS verification_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    email TEXT NOT NULL COLLATE NOCASE,
    purpose TEXT NOT NULL CHECK (purpose IN ('register', 'reset_password')),
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    consumed_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS refresh_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notification_dispatches (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    ding_count INTEGER NOT NULL DEFAULT 0,
    last_ding_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notification_receipts (
    notification_id TEXT PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
    dispatch_id TEXT NOT NULL REFERENCES notification_dispatches(id) ON DELETE CASCADE,
    delivered_at TEXT,
    acknowledged_at TEXT
  );

  CREATE TABLE IF NOT EXISTS contacts (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, contact_id),
    CHECK (owner_id != contact_id)
  );

  CREATE TABLE IF NOT EXISTS direct_messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL,
    CHECK (sender_id != recipient_id)
  );

  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_started INTEGER NOT NULL,
    count INTEGER NOT NULL
  );


  CREATE INDEX IF NOT EXISTS idx_tasks_user_date
    ON tasks(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_codes_email_purpose
    ON verification_codes(email, purpose, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_refresh_hash
    ON refresh_sessions(token_hash);
  CREATE INDEX IF NOT EXISTS idx_notifications_recipient
    ON notifications(recipient_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notification_dispatches_sender
    ON notification_dispatches(sender_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notification_receipts_dispatch
    ON notification_receipts(dispatch_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_owner
    ON contacts(owner_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_pair
    ON direct_messages(sender_id, recipient_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_unread
    ON direct_messages(recipient_id, read_at, created_at DESC);
`;

export const DATABASE_MIGRATION_2 = `
  CREATE TABLE IF NOT EXISTS task_rollover_decisions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_date TEXT NOT NULL,
    target_date TEXT NOT NULL,
    selected_task_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    UNIQUE (user_id, target_date)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_flash_expiry
    ON direct_messages(mode, destroyed_at, expires_at);
  CREATE INDEX IF NOT EXISTS idx_rollover_user_target
    ON task_rollover_decisions(user_id, target_date);
`;

export const DATABASE_MIGRATION_3 = `
  DROP TABLE IF EXISTS tasks_v3;
  CREATE TABLE tasks_v3 (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'done')),
    priority TEXT NOT NULL CHECK (priority IN ('p0', 'p1', 'p2', 'p3', 'p4')),
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'self'
      CHECK (origin IN ('self', 'assigned', 'carryover')),
    assigned_by TEXT,
    assignment_id TEXT,
    source_task_id TEXT,
    assignment_delivered_at TEXT,
    assignment_viewed_at TEXT
  );

  INSERT INTO tasks_v3 (
    id,
    user_id,
    date,
    title,
    details,
    status,
    priority,
    completed_at,
    created_at,
    updated_at,
    origin,
    assigned_by,
    assignment_id,
    source_task_id,
    assignment_delivered_at,
    assignment_viewed_at
  )
  SELECT
    id,
    user_id,
    date,
    title,
    details,
    status,
    priority,
    completed_at,
    created_at,
    updated_at,
    origin,
    assigned_by,
    assignment_id,
    source_task_id,
    assignment_delivered_at,
    assignment_viewed_at
  FROM tasks;

  DROP TABLE tasks;
  ALTER TABLE tasks_v3 RENAME TO tasks;
  CREATE INDEX IF NOT EXISTS idx_tasks_user_date
    ON tasks(user_id, date);
`;

export const DATABASE_MIGRATION_4 = `
  CREATE TABLE IF NOT EXISTS task_audit_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL
      CHECK (action IN (
        'created',
        'updated',
        'completed',
        'reopened',
        'carried_over',
        'assigned',
        'deleted'
      )),
    changes_json TEXT NOT NULL DEFAULT '[]',
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_audit_task_time
    ON task_audit_events(task_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_task_audit_user_task
    ON task_audit_events(user_id, task_id);
`;
