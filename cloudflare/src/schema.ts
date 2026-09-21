export const DATABASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
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

export const DATABASE_MIGRATION_5 = `
  CREATE TABLE IF NOT EXISTS boss_lora_report_opens (
    boss_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    report_date TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    trigger TEXT NOT NULL
      CHECK (trigger IN ('startup', 'login', '08:00', 'reconnect')),
    PRIMARY KEY (boss_user_id, report_date)
  );

  CREATE TABLE IF NOT EXISTS lora_chain_checkpoint (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    checkpoint_block INTEGER,
    checkpoint_hash TEXT,
    block_cursor_json TEXT,
    transaction_cursor_json TEXT,
    burn_cursor_json TEXT,
    burn_history_cursor_json TEXT,
    head_transaction_hash TEXT,
    head_burn_key TEXT,
    block_head_cursor_json TEXT,
    block_head_candidate_key TEXT,
    transaction_head_cursor_json TEXT,
    transaction_head_candidate_hash TEXT,
    burn_head_cursor_json TEXT,
    burn_head_candidate_key TEXT,
    swap_checkpoint_block INTEGER,
    pending_internal_transactions_json TEXT NOT NULL DEFAULT '[]',
    internal_details_complete INTEGER NOT NULL DEFAULT 0,
    swap_today_complete INTEGER NOT NULL DEFAULT 0,
    bootstrap_date TEXT,
    transaction_today_complete INTEGER NOT NULL DEFAULT 0,
    transaction_yesterday_complete INTEGER NOT NULL DEFAULT 0,
    burn_today_complete INTEGER NOT NULL DEFAULT 0,
    block_today_complete INTEGER NOT NULL DEFAULT 0,
    today_complete INTEGER NOT NULL DEFAULT 0,
    yesterday_complete INTEGER NOT NULL DEFAULT 0,
    history_complete INTEGER NOT NULL DEFAULT 0,
    current_total_addresses TEXT,
    next_run_at TEXT,
    last_attempt_at TEXT,
    last_successful_sync_at TEXT,
    last_0800_date TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS lora_chain_blocks (
    height INTEGER PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    parent_hash TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    gas_used TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lora_chain_transactions (
    hash TEXT PRIMARY KEY,
    block_number INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT,
    value_wei TEXT NOT NULL,
    success INTEGER NOT NULL,
    gas_used TEXT NOT NULL,
    gas_price_wei TEXT NOT NULL,
    input TEXT NOT NULL,
    to_is_contract INTEGER
  );

  CREATE TABLE IF NOT EXISTS lora_chain_internal_transactions (
    transaction_hash TEXT NOT NULL,
    trace_index TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT,
    value_wei TEXT NOT NULL,
    success INTEGER NOT NULL,
    call_type TEXT NOT NULL,
    PRIMARY KEY (transaction_hash, trace_index)
  );

  CREATE TABLE IF NOT EXISTS lora_chain_swaps (
    transaction_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    block_number INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    side TEXT NOT NULL,
    lrb_wei TEXT NOT NULL,
    usdt_units TEXT NOT NULL,
    price_usdt TEXT NOT NULL,
    initiator TEXT NOT NULL,
    current_native_balance_wei TEXT,
    PRIMARY KEY (transaction_hash, log_index)
  );

  CREATE TABLE IF NOT EXISTS lora_chain_address_baselines (
    report_date TEXT PRIMARY KEY,
    total_addresses TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    block_number INTEGER
  );

  CREATE TABLE IF NOT EXISTS lora_chain_price (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL,
    price_usdt TEXT,
    reserve_usdt TEXT,
    reserve_wlrb TEXT,
    block_number INTEGER,
    updated_at TEXT,
    source TEXT,
    config_error TEXT
  );

  CREATE TABLE IF NOT EXISTS lora_chain_health (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    rpc_status TEXT NOT NULL,
    explorer_status TEXT NOT NULL,
    collector_status TEXT NOT NULL,
    last_rpc_success_at TEXT,
    last_explorer_success_at TEXT,
    last_successful_sync_at TEXT,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS lora_chain_dashboard_cache (
    report_date TEXT PRIMARY KEY,
    dashboard_json TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    last_successful_sync_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_lora_blocks_time
    ON lora_chain_blocks(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_lora_transactions_time
    ON lora_chain_transactions(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_lora_internal_time
    ON lora_chain_internal_transactions(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_lora_internal_to_time
    ON lora_chain_internal_transactions(to_address, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_lora_swaps_time
    ON lora_chain_swaps(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_lora_report_date
    ON boss_lora_report_opens(report_date, boss_user_id);
`;

export const DATABASE_MIGRATION_6 = `
  CREATE TABLE IF NOT EXISTS boss_work_report_statuses (
    boss_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    report_date TEXT NOT NULL,
    trigger TEXT NOT NULL
      CHECK (trigger IN ('startup', 'login', 'resume', 'reconnect', 'day-change')),
    opened_at TEXT NOT NULL,
    dismissed_at TEXT,
    read_at TEXT,
    PRIMARY KEY (boss_user_id, report_date)
  );
  CREATE INDEX IF NOT EXISTS idx_work_report_pending
    ON boss_work_report_statuses(boss_user_id, read_at, report_date DESC);
`;

export const LORA_RETENTION_QUERIES = {
  blocks:
    "DELETE FROM lora_chain_blocks WHERE datetime(timestamp) < datetime(?)",
  transactions: `DELETE FROM lora_chain_transactions
    WHERE datetime(timestamp) < datetime(?)`,
  nonBurnInternals: `DELETE FROM lora_chain_internal_transactions
    WHERE datetime(timestamp) < datetime(?)
      AND lower(COALESCE(to_address, '')) <> ?`,
  swaps: `DELETE FROM lora_chain_swaps
    WHERE datetime(timestamp) < datetime(?)
      AND rowid <> (
        SELECT rowid FROM lora_chain_swaps
        ORDER BY datetime(timestamp) DESC LIMIT 1
      )`,
} as const;

export const LORA_INSERT_ADDRESS_BASELINE = `INSERT INTO lora_chain_address_baselines
  (report_date, total_addresses, captured_at, block_number)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(report_date) DO NOTHING`;
