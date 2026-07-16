CREATE DATABASE IF NOT EXISTS campus_final_scoring
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'contest_scoring'@'localhost' IDENTIFIED BY 'change-this-password';
CREATE USER IF NOT EXISTS 'contest_scoring'@'127.0.0.1' IDENTIFIED BY 'change-this-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, REFERENCES
  ON campus_final_scoring.*
  TO 'contest_scoring'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, REFERENCES
  ON campus_final_scoring.*
  TO 'contest_scoring'@'127.0.0.1';
FLUSH PRIVILEGES;

USE campus_final_scoring;

CREATE TABLE IF NOT EXISTS contest_final_teams (
  team_id VARCHAR(16) NOT NULL,
  group_id VARCHAR(32) NOT NULL,
  registration_number VARCHAR(64) NOT NULL DEFAULT '',
  team_name VARCHAR(255) NOT NULL,
  project_name VARCHAR(255) NOT NULL DEFAULT '',
  appearance_order INT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  roster_snapshot JSON NULL,
  state_created_at VARCHAR(64) NOT NULL DEFAULT '',
  state_updated_at VARCHAR(64) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (team_id),
  INDEX idx_group_appearance (group_id, appearance_order),
  INDEX idx_team_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contest_final_accounts (
  account_id VARCHAR(32) NOT NULL,
  username VARCHAR(64) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  password_hash VARCHAR(1024) NOT NULL,
  password_version INT UNSIGNED NOT NULL DEFAULT 1,
  auth_version INT UNSIGNED NOT NULL DEFAULT 1,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  state_created_at VARCHAR(64) NOT NULL DEFAULT '',
  state_updated_at VARCHAR(64) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id),
  UNIQUE KEY uq_username (username),
  INDEX idx_account_role_status (role, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contest_final_account_sessions (
  session_id CHAR(32) NOT NULL,
  account_id VARCHAR(32) NOT NULL,
  token_hash BINARY(32) NOT NULL,
  auth_version INT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  device_id VARCHAR(80) NOT NULL DEFAULT '',
  revoked_at BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id),
  UNIQUE KEY uq_session_token_hash (token_hash),
  INDEX idx_session_account_expiry (account_id, expires_at),
  CONSTRAINT contest_final_sessions_account_fk
    FOREIGN KEY (account_id) REFERENCES contest_final_accounts (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contest_final_judge_roster (
  account_id VARCHAR(32) NOT NULL,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id),
  UNIQUE KEY uq_roster_order (sort_order),
  CONSTRAINT contest_final_roster_account_fk
    FOREIGN KEY (account_id) REFERENCES contest_final_accounts (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contest_final_entries (
  judge_id VARCHAR(32) NOT NULL,
  candidate_id VARCHAR(16) NOT NULL,
  scores_json JSON NOT NULL,
  submitted TINYINT(1) NOT NULL DEFAULT 0,
  updated_at VARCHAR(64) NOT NULL DEFAULT '',
  client_updated_at BIGINT NOT NULL DEFAULT 0,
  server_revision INT UNSIGNED NOT NULL DEFAULT 0,
  server_updated_at VARCHAR(64) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (judge_id, candidate_id),
  INDEX idx_candidate_submitted (candidate_id, submitted),
  INDEX idx_judge (judge_id),
  CONSTRAINT contest_final_entries_judge_fk
    FOREIGN KEY (judge_id) REFERENCES contest_final_accounts (account_id),
  CONSTRAINT contest_final_entries_team_fk
    FOREIGN KEY (candidate_id) REFERENCES contest_final_teams (team_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contest_final_control_state (
  control_key VARCHAR(64) NOT NULL,
  control_value MEDIUMTEXT NOT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at VARCHAR(64) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (control_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contest_final_audit_events (
  event_id VARCHAR(80) NOT NULL,
  action VARCHAR(64) NOT NULL,
  actor_id VARCHAR(32) NOT NULL DEFAULT '',
  target_id VARCHAR(32) NOT NULL DEFAULT '',
  details_json JSON NOT NULL,
  event_created_at VARCHAR(64) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id),
  INDEX idx_audit_action_created (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Retained only so existing pre-v4 MySQL data can be read once and migrated into teams.
CREATE TABLE IF NOT EXISTS contest_final_candidate_overrides (
  candidate_id VARCHAR(16) NOT NULL,
  team VARCHAR(255) NOT NULL DEFAULT '',
  product VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (candidate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contest_final_candidate_order (
  group_id VARCHAR(32) NOT NULL,
  candidate_id VARCHAR(16) NOT NULL,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, candidate_id),
  INDEX idx_group_order (group_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
