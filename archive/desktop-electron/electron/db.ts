import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { resolveAssetSourceToPath } from './core/localAssetManager';

const getLegacyUserDataDirs = (): string[] => {
  const currentUserData = path.resolve(app.getPath('userData'));
  const parentDir = path.dirname(currentUserData);
  const currentBaseName = path.basename(currentUserData);
  const candidates = [
    'RedBox',
    'red-convert-desktop',
    'RedConvert',
    'redconvert-desktop',
    'com.redbox.app',
    app.name,
  ];
  return Array.from(new Set(
    candidates
      .map((name) => String(name || '').trim())
      .filter(Boolean)
      .filter((name) => name !== currentBaseName)
      .map((name) => path.join(parentDir, name))
      .filter((candidate) => path.resolve(candidate) !== currentUserData),
  ));
};

const migrateLegacyUserDataFileIfNeeded = (fileName: string): string => {
  const currentPath = path.join(app.getPath('userData'), fileName);
  try {
    if (fs.existsSync(currentPath) && fs.statSync(currentPath).size > 0) {
      return currentPath;
    }
  } catch {
    // fall through to legacy probe
  }

  for (const legacyDir of getLegacyUserDataDirs()) {
    const legacyPath = path.join(legacyDir, fileName);
    try {
      if (!fs.existsSync(legacyPath)) continue;
      if (fs.statSync(legacyPath).size <= 0) continue;
      fs.mkdirSync(path.dirname(currentPath), { recursive: true });
      fs.copyFileSync(legacyPath, currentPath);
      console.log(`[UserDataMigration] migrated ${fileName} from ${legacyPath} to ${currentPath}`);
      return currentPath;
    } catch (error) {
      console.warn(`[UserDataMigration] failed to migrate ${fileName} from ${legacyPath}:`, error);
    }
  }

  return currentPath;
};

const dbPath = migrateLegacyUserDataFileIfNeeded('redconvert.db');
const db = new Database(dbPath);

const DEFAULT_SPACE_ID = 'default';
const DEFAULT_SPACE_NAME = '默认空间';
const DEFAULT_CHAT_MAX_TOKENS = 262144;
const DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK = 131072;
const MIN_CHAT_MAX_TOKENS = 1024;

const normalizeChatMaxTokens = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_CHAT_MAX_TOKENS) {
    return fallback;
  }
  return Math.floor(parsed);
};

const hasColumn = (tableName: string, columnName: string): boolean => {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === columnName);
  } catch {
    return false;
  }
};

// Initialize tables
const initDb = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      api_endpoint TEXT,
      api_key TEXT,
      model_name TEXT,
      model_name_wander TEXT,
      model_name_chatroom TEXT,
      model_name_knowledge TEXT,
      model_name_redclaw TEXT,
      search_provider TEXT,
      search_endpoint TEXT,
      search_api_key TEXT,
      proxy_enabled INTEGER,
      proxy_url TEXT,
      proxy_bypass TEXT,
      role_mapping TEXT,
      workspace_dir TEXT,
      active_space_id TEXT,
      transcription_model TEXT,
      transcription_endpoint TEXT,
      transcription_key TEXT,
      ai_sources_json TEXT,
      default_ai_source_id TEXT,
      image_provider TEXT,
      image_endpoint TEXT,
      image_api_key TEXT,
      image_model TEXT,
      video_endpoint TEXT,
      video_api_key TEXT,
      video_model TEXT,
      image_provider_template TEXT,
      image_aspect_ratio TEXT,
      image_size TEXT,
      image_quality TEXT,
      mcp_servers_json TEXT,
      redclaw_compact_target_tokens INTEGER,
      wander_deep_think_enabled INTEGER,
      debug_log_enabled INTEGER,
      developer_mode_enabled INTEGER,
      developer_mode_unlocked_at TEXT,
      chat_max_tokens_default INTEGER,
      chat_max_tokens_deepseek INTEGER
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT,
      goal TEXT,
      domain TEXT,
      audience TEXT,
      tone_tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS archive_samples (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      title TEXT,
      content TEXT,
      excerpt TEXT,
      tags TEXT,
      images TEXT,
      platform TEXT,
      source_url TEXT,
      sample_date TEXT,
      is_featured INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (profile_id) REFERENCES archive_profiles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_archive_samples_profile_id
      ON archive_samples(profile_id);
    CREATE INDEX IF NOT EXISTS idx_archive_samples_created_at
      ON archive_samples(created_at);
  `);

  // Chat history tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      tool_call_id TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id
      ON chat_messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp
      ON chat_messages(timestamp);

    CREATE TABLE IF NOT EXISTS session_transcript_records (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      record_type TEXT NOT NULL,
      role TEXT,
      content TEXT,
      payload_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_session_transcript_records_session
      ON session_transcript_records(session_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS session_checkpoints (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      checkpoint_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_session_checkpoints_session
      ON session_checkpoints(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS session_tool_results (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      command TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      result_text TEXT,
      summary_text TEXT,
      prompt_text TEXT,
      original_chars INTEGER,
      prompt_chars INTEGER,
      truncated INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_session_tool_results_session
      ON session_tool_results(session_id, created_at ASC);

    CREATE INDEX IF NOT EXISTS idx_session_tool_results_call
      ON session_tool_results(session_id, call_id);

    CREATE TABLE IF NOT EXISTS knowledge_vectors (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB NOT NULL,
      metadata TEXT,
      content_hash TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_vectors_source ON knowledge_vectors(source_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      owner_session_id TEXT,
      intent TEXT,
      role_id TEXT,
      goal TEXT,
      current_node TEXT,
      route_json TEXT,
      graph_json TEXT,
      artifacts_json TEXT,
      checkpoints_json TEXT,
      metadata_json TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_agent_tasks_status_updated
      ON agent_tasks(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_owner_session
      ON agent_tasks(owner_session_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_task_traces (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      node_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_task_traces_task
      ON agent_task_traces(task_id, created_at ASC);
  `);

  // User Memory tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_memories (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL DEFAULT '${DEFAULT_SPACE_ID}',
      content TEXT NOT NULL,
      type TEXT DEFAULT 'general',
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_memories_created_at ON user_memories(created_at);
  `);

  // Migration: add workspace_dir column if missing
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN workspace_dir TEXT;`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN active_space_id TEXT;`);
  } catch { /* Column already exists */ }

  // Migration: add embedding columns if missing
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN embedding_endpoint TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN embedding_key TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN embedding_model TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN ai_sources_json TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN default_ai_source_id TEXT;`);
  } catch { /* Column already exists */ }

  try {
    db.exec(`ALTER TABLE settings ADD COLUMN transcription_model TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN transcription_endpoint TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN transcription_key TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN image_provider TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN image_endpoint TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN image_api_key TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN image_model TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN video_endpoint TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN video_api_key TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN video_model TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN image_provider_template TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN image_aspect_ratio TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN image_size TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN image_quality TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN mcp_servers_json TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN redclaw_compact_target_tokens INTEGER;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN wander_deep_think_enabled INTEGER;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN debug_log_enabled INTEGER;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN developer_mode_enabled INTEGER;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN developer_mode_unlocked_at TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN chat_max_tokens_default INTEGER;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN chat_max_tokens_deepseek INTEGER;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN model_name_wander TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN model_name_chatroom TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN model_name_knowledge TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN search_provider TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN search_endpoint TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN search_api_key TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN proxy_enabled INTEGER;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN proxy_url TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN proxy_bypass TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN model_name_redclaw TEXT;`);
  } catch { /* Column already exists */ }

  try {
    db.exec(`ALTER TABLE archive_samples ADD COLUMN images TEXT;`);
  } catch { /* Column already exists */ }

  // Migration: add display_content and attachment columns for chat_messages
  try {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN display_content TEXT;`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN attachment TEXT;`);
  } catch { /* Column already exists */ }

  // Migration: add content_hash column for knowledge_vectors
  try {
    db.exec(`ALTER TABLE knowledge_vectors ADD COLUMN content_hash TEXT;`);
  } catch { /* Column already exists */ }

  // Migration: add space_id for user memories
  try {
    db.exec(`ALTER TABLE user_memories ADD COLUMN space_id TEXT;`);
  } catch { /* Column already exists */ }
  if (hasColumn('user_memories', 'space_id')) {
    db.exec(`
      UPDATE user_memories
      SET space_id = COALESCE(
        (SELECT NULLIF(active_space_id, '') FROM settings WHERE id = 1),
        '${DEFAULT_SPACE_ID}'
      )
      WHERE space_id IS NULL OR space_id = ''
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_space_created_at ON user_memories(space_id, created_at);`);
  }

  // Migration: file index tracking tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_index_lanes (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      lane TEXT NOT NULL,
      status TEXT DEFAULT 'idle',
      done INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      metadata_only INTEGER DEFAULT 0,
      last_updated_at TEXT,
      next_retry_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_file_index_lanes_scope
      ON file_index_lanes(scope_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS file_index_events (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_file_index_events_source
      ON file_index_events(source_id);
    CREATE INDEX IF NOT EXISTS idx_file_index_events_type
      ON file_index_events(event_type);
  `);

  // Idempotent migration: populate file_index_lanes from existing knowledge_vectors
  db.exec(`
    INSERT OR IGNORE INTO file_index_lanes (id, scope_id, lane, status, done, total)
    SELECT
      v.source_id as id,
      COALESCE(json_extract(v.metadata, '$.scope'), 'unknown') as scope_id,
      'vectors' as lane,
      'idle' as status,
      COUNT(*) as done,
      COUNT(*) as total
    FROM knowledge_vectors v
    GROUP BY v.source_id;
  `);

  const now = Date.now();
  db.prepare(`
    INSERT INTO spaces (id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(DEFAULT_SPACE_ID, DEFAULT_SPACE_NAME, now, now);

  db.exec(`
    UPDATE settings
    SET active_space_id = '${DEFAULT_SPACE_ID}'
    WHERE id = 1 AND (active_space_id IS NULL OR active_space_id = '')
  `);
};

initDb();

// Default workspace directory
export const getDefaultWorkspaceDir = () => {
  return path.join(app.getPath('home'), '.redconvert');
};

const normalizeWorkspaceDir = (raw: string | undefined | null): string => {
  const fallback = path.resolve(getDefaultWorkspaceDir());
  const value = String(raw || '').trim();
  if (!value) return fallback;

  let next = value;
  if (/^file:\/\//i.test(next)) {
    try {
      next = fileURLToPath(next);
    } catch {
      // keep raw fallback
    }
  } else if (/^(local-file|redbox-asset):\/\//i.test(next)) {
    try {
      next = resolveAssetSourceToPath(next);
    } catch {
      next = next.replace(/^(local-file|redbox-asset):\/+/i, '/');
    }
  }

  return path.resolve(path.normalize(next || fallback));
};

export const saveSettings = (settings: {
  api_endpoint?: string;
  api_key?: string;
  model_name?: string;
    model_name_wander?: string;
    model_name_chatroom?: string;
    model_name_knowledge?: string;
    model_name_redclaw?: string;
    search_provider?: string;
    search_endpoint?: string;
    search_api_key?: string;
    proxy_enabled?: boolean;
    proxy_url?: string;
    proxy_bypass?: string;
    role_mapping?: string;
  workspace_dir?: string;
  active_space_id?: string;
  transcription_model?: string;
  transcription_endpoint?: string;
  transcription_key?: string;
  embedding_endpoint?: string;
  embedding_key?: string;
  embedding_model?: string;
  ai_sources_json?: string;
  default_ai_source_id?: string;
  image_provider?: string;
  image_endpoint?: string;
  image_api_key?: string;
  image_model?: string;
  video_endpoint?: string;
  video_api_key?: string;
  video_model?: string;
  image_provider_template?: string;
  image_aspect_ratio?: string;
  image_size?: string;
  image_quality?: string;
  mcp_servers_json?: string;
  redclaw_compact_target_tokens?: number;
  wander_deep_think_enabled?: boolean;
  debug_log_enabled?: boolean;
  developer_mode_enabled?: boolean;
  developer_mode_unlocked_at?: string | null;
  chat_max_tokens_default?: number;
  chat_max_tokens_deepseek?: number;
}) => {
  const stmt = db.prepare(`
    INSERT INTO settings (id, api_endpoint, api_key, model_name, model_name_wander, model_name_chatroom, model_name_knowledge, model_name_redclaw, search_provider, search_endpoint, search_api_key, proxy_enabled, proxy_url, proxy_bypass, role_mapping, workspace_dir, active_space_id, transcription_model, transcription_endpoint, transcription_key, embedding_endpoint, embedding_key, embedding_model, ai_sources_json, default_ai_source_id, image_provider, image_endpoint, image_api_key, image_model, video_endpoint, video_api_key, video_model, image_provider_template, image_aspect_ratio, image_size, image_quality, mcp_servers_json, redclaw_compact_target_tokens, wander_deep_think_enabled, debug_log_enabled, developer_mode_enabled, developer_mode_unlocked_at, chat_max_tokens_default, chat_max_tokens_deepseek)
    VALUES (1, @api_endpoint, @api_key, @model_name, @model_name_wander, @model_name_chatroom, @model_name_knowledge, @model_name_redclaw, @search_provider, @search_endpoint, @search_api_key, @proxy_enabled, @proxy_url, @proxy_bypass, @role_mapping, @workspace_dir, @active_space_id, @transcription_model, @transcription_endpoint, @transcription_key, @embedding_endpoint, @embedding_key, @embedding_model, @ai_sources_json, @default_ai_source_id, @image_provider, @image_endpoint, @image_api_key, @image_model, @video_endpoint, @video_api_key, @video_model, @image_provider_template, @image_aspect_ratio, @image_size, @image_quality, @mcp_servers_json, @redclaw_compact_target_tokens, @wander_deep_think_enabled, @debug_log_enabled, @developer_mode_enabled, @developer_mode_unlocked_at, @chat_max_tokens_default, @chat_max_tokens_deepseek)
    ON CONFLICT(id) DO UPDATE SET
      api_endpoint = @api_endpoint,
      api_key = @api_key,
      model_name = @model_name,
      model_name_wander = @model_name_wander,
      model_name_chatroom = @model_name_chatroom,
      model_name_knowledge = @model_name_knowledge,
      model_name_redclaw = @model_name_redclaw,
      search_provider = @search_provider,
      search_endpoint = @search_endpoint,
      search_api_key = @search_api_key,
      proxy_enabled = @proxy_enabled,
      proxy_url = @proxy_url,
      proxy_bypass = @proxy_bypass,
      role_mapping = @role_mapping,
      workspace_dir = @workspace_dir,
      active_space_id = @active_space_id,
      transcription_model = @transcription_model,
      transcription_endpoint = @transcription_endpoint,
      transcription_key = @transcription_key,
      embedding_endpoint = @embedding_endpoint,
      embedding_key = @embedding_key,
      embedding_model = @embedding_model,
      ai_sources_json = @ai_sources_json,
      default_ai_source_id = @default_ai_source_id,
      image_provider = @image_provider,
      image_endpoint = @image_endpoint,
      image_api_key = @image_api_key,
      image_model = @image_model,
      video_endpoint = @video_endpoint,
      video_api_key = @video_api_key,
      video_model = @video_model,
      image_provider_template = @image_provider_template,
      image_aspect_ratio = @image_aspect_ratio,
      image_size = @image_size,
      image_quality = @image_quality,
      mcp_servers_json = @mcp_servers_json,
      redclaw_compact_target_tokens = @redclaw_compact_target_tokens,
      wander_deep_think_enabled = @wander_deep_think_enabled,
      debug_log_enabled = @debug_log_enabled,
      developer_mode_enabled = @developer_mode_enabled,
      developer_mode_unlocked_at = @developer_mode_unlocked_at,
      chat_max_tokens_default = @chat_max_tokens_default,
      chat_max_tokens_deepseek = @chat_max_tokens_deepseek
  `);
  const current = getSettings() as {
    api_endpoint?: string;
    api_key?: string;
    model_name?: string;
    model_name_wander?: string;
    model_name_chatroom?: string;
    model_name_knowledge?: string;
    model_name_redclaw?: string;
    search_provider?: string;
    search_endpoint?: string;
    search_api_key?: string;
    proxy_enabled?: boolean;
    proxy_url?: string;
    proxy_bypass?: string;
    role_mapping?: string;
    workspace_dir?: string;
    active_space_id?: string;
    transcription_model?: string;
    transcription_endpoint?: string;
    transcription_key?: string;
    embedding_endpoint?: string;
    embedding_key?: string;
    embedding_model?: string;
    ai_sources_json?: string;
    default_ai_source_id?: string;
    image_provider?: string;
    image_endpoint?: string;
    image_api_key?: string;
    image_model?: string;
    video_endpoint?: string;
    video_api_key?: string;
    video_model?: string;
    image_provider_template?: string;
    image_aspect_ratio?: string;
    image_size?: string;
    image_quality?: string;
    mcp_servers_json?: string;
    redclaw_compact_target_tokens?: number;
    wander_deep_think_enabled?: boolean;
    debug_log_enabled?: boolean;
    developer_mode_enabled?: boolean;
    developer_mode_unlocked_at?: string | null;
    chat_max_tokens_default?: number;
    chat_max_tokens_deepseek?: number;
  } | undefined;
  return stmt.run({
    ...settings,
    api_endpoint: Object.prototype.hasOwnProperty.call(settings, 'api_endpoint')
      ? String(settings.api_endpoint || '').trim()
      : String(current?.api_endpoint || '').trim(),
    api_key: Object.prototype.hasOwnProperty.call(settings, 'api_key')
      ? String(settings.api_key || '').trim()
      : String(current?.api_key || '').trim(),
    model_name: Object.prototype.hasOwnProperty.call(settings, 'model_name')
      ? String(settings.model_name || '').trim()
      : String(current?.model_name || '').trim(),
    model_name_wander: String(settings.model_name_wander ?? current?.model_name_wander ?? '').trim(),
    model_name_chatroom: String(settings.model_name_chatroom ?? current?.model_name_chatroom ?? '').trim(),
    model_name_knowledge: String(settings.model_name_knowledge ?? current?.model_name_knowledge ?? '').trim(),
    model_name_redclaw: String(settings.model_name_redclaw ?? current?.model_name_redclaw ?? '').trim(),
    search_provider: String(settings.search_provider ?? current?.search_provider ?? 'duckduckgo').trim() || 'duckduckgo',
    search_endpoint: String(settings.search_endpoint ?? current?.search_endpoint ?? '').trim(),
    search_api_key: String(settings.search_api_key ?? current?.search_api_key ?? '').trim(),
    proxy_enabled: settings.proxy_enabled === undefined
      ? (current?.proxy_enabled ? 1 : 0)
      : (settings.proxy_enabled ? 1 : 0),
    proxy_url: String(settings.proxy_url ?? current?.proxy_url ?? '').trim(),
    proxy_bypass: String(settings.proxy_bypass ?? current?.proxy_bypass ?? '').trim(),
    role_mapping: settings.role_mapping === undefined
      ? (current?.role_mapping || '{}')
      : typeof settings.role_mapping === 'object'
        ? JSON.stringify(settings.role_mapping)
        : (settings.role_mapping || '{}'),
    workspace_dir: normalizeWorkspaceDir(settings.workspace_dir ?? current?.workspace_dir ?? getDefaultWorkspaceDir()),
    active_space_id: settings.active_space_id || current?.active_space_id || DEFAULT_SPACE_ID,
    transcription_model: settings.transcription_model ?? current?.transcription_model ?? '',
    transcription_endpoint: settings.transcription_endpoint ?? current?.transcription_endpoint ?? '',
    transcription_key: settings.transcription_key ?? current?.transcription_key ?? '',
    embedding_endpoint: settings.embedding_endpoint ?? current?.embedding_endpoint ?? '',
    embedding_key: settings.embedding_key ?? current?.embedding_key ?? '',
    embedding_model: settings.embedding_model ?? current?.embedding_model ?? '',
    ai_sources_json: settings.ai_sources_json ?? current?.ai_sources_json ?? '',
    default_ai_source_id: settings.default_ai_source_id ?? current?.default_ai_source_id ?? '',
    image_provider: settings.image_provider ?? current?.image_provider ?? '',
    image_endpoint: settings.image_endpoint ?? current?.image_endpoint ?? '',
    image_api_key: settings.image_api_key ?? current?.image_api_key ?? '',
    image_model: settings.image_model ?? current?.image_model ?? '',
    video_endpoint: settings.video_endpoint ?? current?.video_endpoint ?? '',
    video_api_key: settings.video_api_key ?? current?.video_api_key ?? '',
    video_model: settings.video_model ?? current?.video_model ?? '',
    image_provider_template: settings.image_provider_template ?? current?.image_provider_template ?? '',
    image_aspect_ratio: settings.image_aspect_ratio ?? current?.image_aspect_ratio ?? '',
    image_size: settings.image_size ?? current?.image_size ?? '',
    image_quality: settings.image_quality ?? current?.image_quality ?? '',
    mcp_servers_json: settings.mcp_servers_json ?? current?.mcp_servers_json ?? '[]',
    redclaw_compact_target_tokens: Number.isFinite(Number(settings.redclaw_compact_target_tokens))
      ? Math.floor(Number(settings.redclaw_compact_target_tokens))
      : Number.isFinite(Number(current?.redclaw_compact_target_tokens))
        ? Math.floor(Number(current?.redclaw_compact_target_tokens))
        : 256000,
    wander_deep_think_enabled: settings.wander_deep_think_enabled === undefined
      ? (current?.wander_deep_think_enabled ? 1 : 0)
      : (settings.wander_deep_think_enabled ? 1 : 0),
    debug_log_enabled: settings.debug_log_enabled === undefined
      ? (current?.debug_log_enabled ? 1 : 0)
      : (settings.debug_log_enabled ? 1 : 0),
    developer_mode_enabled: settings.developer_mode_enabled === undefined
      ? (current?.developer_mode_enabled ? 1 : 0)
      : (settings.developer_mode_enabled ? 1 : 0),
    developer_mode_unlocked_at: settings.developer_mode_unlocked_at === undefined
      ? (current?.developer_mode_unlocked_at ?? null)
      : (settings.developer_mode_unlocked_at || null),
    chat_max_tokens_default: normalizeChatMaxTokens(
      settings.chat_max_tokens_default,
      normalizeChatMaxTokens(current?.chat_max_tokens_default, DEFAULT_CHAT_MAX_TOKENS),
    ),
    chat_max_tokens_deepseek: normalizeChatMaxTokens(
      settings.chat_max_tokens_deepseek,
      normalizeChatMaxTokens(current?.chat_max_tokens_deepseek, DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK),
    ),
  });
};

export const getSettings = () => {
  const stmt = db.prepare('SELECT * FROM settings WHERE id = 1');
  const result = stmt.get() as {
    api_endpoint?: string;
    api_key?: string;
    model_name?: string;
    model_name_wander?: string;
    model_name_chatroom?: string;
    model_name_knowledge?: string;
    model_name_redclaw?: string;
    search_provider?: string;
    search_endpoint?: string;
    search_api_key?: string;
    proxy_enabled?: number;
    proxy_url?: string;
    proxy_bypass?: string;
    role_mapping?: string;
    workspace_dir?: string;
    active_space_id?: string;
    transcription_model?: string;
    transcription_endpoint?: string;
    transcription_key?: string;
    embedding_endpoint?: string;
    embedding_key?: string;
    embedding_model?: string;
    ai_sources_json?: string;
    default_ai_source_id?: string;
    image_provider?: string;
    image_endpoint?: string;
    image_api_key?: string;
    image_model?: string;
    video_endpoint?: string;
    video_api_key?: string;
    video_model?: string;
    image_provider_template?: string;
    image_aspect_ratio?: string;
    image_size?: string;
    image_quality?: string;
    mcp_servers_json?: string;
    redclaw_compact_target_tokens?: number;
    wander_deep_think_enabled?: number;
    debug_log_enabled?: number;
    developer_mode_enabled?: number;
    developer_mode_unlocked_at?: string | null;
    chat_max_tokens_default?: number;
    chat_max_tokens_deepseek?: number;
  } | undefined;
  let shouldRepairChatTokenSettings = false;
  // Ensure workspace_dir has a default value
  if (result && !result.workspace_dir) {
    result.workspace_dir = getDefaultWorkspaceDir();
  }
  if (result && !result.search_provider) {
    result.search_provider = 'duckduckgo';
  }
  if (result && !result.proxy_bypass) {
    result.proxy_bypass = 'localhost,127.0.0.1,::1';
  }
  if (result?.workspace_dir) {
    result.workspace_dir = normalizeWorkspaceDir(result.workspace_dir);
  }
  if (result && !result.active_space_id) {
    result.active_space_id = DEFAULT_SPACE_ID;
  }
  if (result && !result.mcp_servers_json) {
    result.mcp_servers_json = '[]';
  }
  if (result && !Number.isFinite(Number(result.redclaw_compact_target_tokens))) {
    result.redclaw_compact_target_tokens = 256000;
  }
  if (result && Number(result.chat_max_tokens_default) < MIN_CHAT_MAX_TOKENS) {
    result.chat_max_tokens_default = DEFAULT_CHAT_MAX_TOKENS;
    shouldRepairChatTokenSettings = true;
  } else if (result && !Number.isFinite(Number(result.chat_max_tokens_default))) {
    result.chat_max_tokens_default = DEFAULT_CHAT_MAX_TOKENS;
    shouldRepairChatTokenSettings = true;
  }
  if (result && Number(result.chat_max_tokens_deepseek) < MIN_CHAT_MAX_TOKENS) {
    result.chat_max_tokens_deepseek = DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK;
    shouldRepairChatTokenSettings = true;
  } else if (result && !Number.isFinite(Number(result.chat_max_tokens_deepseek))) {
    result.chat_max_tokens_deepseek = DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK;
    shouldRepairChatTokenSettings = true;
  }
  if (result && shouldRepairChatTokenSettings) {
    db.prepare(`
      UPDATE settings
      SET chat_max_tokens_default = ?,
          chat_max_tokens_deepseek = ?
      WHERE id = 1
    `).run(result.chat_max_tokens_default, result.chat_max_tokens_deepseek);
  }
  if (result) {
    (result as { wander_deep_think_enabled?: boolean }).wander_deep_think_enabled = Boolean(result.wander_deep_think_enabled);
    (result as { debug_log_enabled?: boolean }).debug_log_enabled = Boolean(result.debug_log_enabled);
    (result as { developer_mode_enabled?: boolean }).developer_mode_enabled = Boolean(result.developer_mode_enabled);
    (result as { proxy_enabled?: boolean }).proxy_enabled = Boolean(result.proxy_enabled);
  }
  return result;
};

// Helper to get current workspace paths
const hasLegacyWorkspaceContent = (baseDir: string): boolean => {
  const legacyDirs = ['knowledge', 'manuscripts', 'advisors', 'archives', 'chatrooms', 'skills'];
  return legacyDirs.some((dirName) => fs.existsSync(path.join(baseDir, dirName)));
};

const resolveSpaceBaseDir = (workspaceRoot: string, spaceId: string): string => {
  const normalizedSpaceId = spaceId || DEFAULT_SPACE_ID;
  const spaceDir = path.join(workspaceRoot, 'spaces', normalizedSpaceId);
  if (
    normalizedSpaceId === DEFAULT_SPACE_ID &&
    !fs.existsSync(spaceDir) &&
    hasLegacyWorkspaceContent(workspaceRoot)
  ) {
    return workspaceRoot;
  }
  return spaceDir;
};

export const getWorkspacePathsForSpace = (spaceId: string) => {
  const settings = getSettings() as { workspace_dir?: string } | undefined;
  const baseDir = normalizeWorkspaceDir(settings?.workspace_dir || getDefaultWorkspaceDir());
  const activeSpaceId = spaceId || DEFAULT_SPACE_ID;
  const spaceBaseDir = resolveSpaceBaseDir(baseDir, activeSpaceId);
  return {
    workspaceRoot: baseDir,
    activeSpaceId,
    spacesRoot: path.join(baseDir, 'spaces'),
    base: spaceBaseDir,
    skills: path.join(spaceBaseDir, 'skills'),
    knowledge: path.join(spaceBaseDir, 'knowledge'),
    knowledgeRedbook: path.join(spaceBaseDir, 'knowledge', 'redbook'),
    knowledgeYoutube: path.join(spaceBaseDir, 'knowledge', 'youtube'),
    advisors: path.join(spaceBaseDir, 'advisors'),
    manuscripts: path.join(spaceBaseDir, 'manuscripts'),
    media: path.join(spaceBaseDir, 'media'),
    cover: path.join(spaceBaseDir, 'cover'),
    subjects: path.join(spaceBaseDir, 'subjects'),
    redclaw: path.join(spaceBaseDir, 'redclaw'),
  };
};

export const getWorkspacePaths = () => {
  const settings = getSettings() as { active_space_id?: string } | undefined;
  const activeSpaceId = settings?.active_space_id || DEFAULT_SPACE_ID;
  return getWorkspacePathsForSpace(activeSpaceId);
};

export interface WorkspaceSpace {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

const generateSpaceId = (name: string): string => {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const candidate = base || `space-${Date.now()}`;

  const exists = db.prepare('SELECT 1 FROM spaces WHERE id = ? LIMIT 1');
  if (!exists.get(candidate)) return candidate;

  let index = 2;
  while (exists.get(`${candidate}-${index}`)) {
    index += 1;
  }
  return `${candidate}-${index}`;
};

export const listSpaces = (): WorkspaceSpace[] => {
  const stmt = db.prepare(`
    SELECT * FROM spaces
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, updated_at DESC
  `);
  return stmt.all(DEFAULT_SPACE_ID) as WorkspaceSpace[];
};

export const createSpace = (name: string): WorkspaceSpace => {
  const trimmedName = name.trim();
  const displayName = trimmedName || '新空间';
  const id = generateSpaceId(displayName);
  const now = Date.now();
  db.prepare(`
    INSERT INTO spaces (id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(id, displayName, now, now);
  return { id, name: displayName, created_at: now, updated_at: now };
};

export const renameSpace = (id: string, name: string): WorkspaceSpace | null => {
  const trimmedName = name.trim();
  if (!trimmedName) return null;

  const existing = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as WorkspaceSpace | undefined;
  if (!existing) return null;

  const now = Date.now();
  const stmt = db.prepare('UPDATE spaces SET name = ?, updated_at = ? WHERE id = ?');
  stmt.run(trimmedName, now, id);
  return { ...existing, name: trimmedName, updated_at: now };
};

export const getActiveSpaceId = (): string => {
  const settings = getSettings() as { active_space_id?: string } | undefined;
  const id = settings?.active_space_id || DEFAULT_SPACE_ID;
  const exists = db.prepare('SELECT 1 FROM spaces WHERE id = ? LIMIT 1').get(id) as { '1': number } | undefined;
  return exists ? id : DEFAULT_SPACE_ID;
};

export const setActiveSpace = (spaceId: string): WorkspaceSpace => {
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(spaceId) as WorkspaceSpace | undefined;
  if (!space) {
    throw new Error('空间不存在');
  }

  const existing = getSettings();
  if (existing) {
    db.prepare('UPDATE settings SET active_space_id = ? WHERE id = 1').run(spaceId);
  } else {
    saveSettings({
      api_endpoint: '',
      api_key: '',
      model_name: '',
      role_mapping: '{}',
      workspace_dir: getDefaultWorkspaceDir(),
      active_space_id: spaceId,
    });
  }

  const now = Date.now();
  db.prepare('UPDATE spaces SET updated_at = ? WHERE id = ?').run(now, spaceId);
  return { ...space, updated_at: now };
};

// ========== User Memory Functions ==========

export interface UserMemory {
  id: string;
  space_id?: string;
  content: string;
  type: 'general' | 'preference' | 'fact';
  tags: string[];
  created_at: number;
  updated_at: number;
  last_accessed?: number;
}

const resolveSpaceId = (spaceId?: string): string => {
  return spaceId || getActiveSpaceId();
};

export const addUserMemory = (
  content: string,
  type: 'general' | 'preference' | 'fact' = 'general',
  tags: string[] = [],
  spaceId?: string
): UserMemory => {
  const now = Date.now();
  const id = `mem_${now}_${Math.random().toString(36).substr(2, 5)}`;
  const scopedSpaceId = resolveSpaceId(spaceId);

  const stmt = db.prepare(`
    INSERT INTO user_memories (id, space_id, content, type, tags, created_at, updated_at, last_accessed)
    VALUES (@id, @space_id, @content, @type, @tags, @created_at, @updated_at, @last_accessed)
  `);

  const memory: UserMemory = {
    id,
    space_id: scopedSpaceId,
    content,
    type,
    tags,
    created_at: now,
    updated_at: now,
    last_accessed: now
  };

  stmt.run({
    ...memory,
    tags: JSON.stringify(tags)
  });

  return memory;
};

export const deleteUserMemory = (id: string): void => {
  const stmt = db.prepare('DELETE FROM user_memories WHERE id = ? AND space_id = ?');
  stmt.run(id, resolveSpaceId());
};

export const updateUserMemory = (id: string, updates: Partial<Pick<UserMemory, 'content' | 'type' | 'tags'>>): void => {
  const now = Date.now();
  const sets: string[] = ['updated_at = @updated_at'];
  const params: any = { id, updated_at: now, space_id: resolveSpaceId() };

  if (updates.content !== undefined) {
    sets.push('content = @content');
    params.content = updates.content;
  }
  if (updates.type !== undefined) {
    sets.push('type = @type');
    params.type = updates.type;
  }
  if (updates.tags !== undefined) {
    sets.push('tags = @tags');
    params.tags = JSON.stringify(updates.tags);
  }

  const stmt = db.prepare(`UPDATE user_memories SET ${sets.join(', ')} WHERE id = @id AND space_id = @space_id`);
  stmt.run(params);
};

export const getUserMemories = (): UserMemory[] => {
  const stmt = db.prepare('SELECT * FROM user_memories WHERE space_id = ? ORDER BY created_at DESC');
  return (stmt.all(resolveSpaceId()) as any[]).map(row => ({
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : []
  }));
};

// ========== Archive Profiles & Samples ==========

export interface ArchiveProfile {
  id: string;
  name: string;
  platform?: string;
  goal?: string;
  domain?: string;
  audience?: string;
  tone_tags: string[];
  created_at: number;
  updated_at: number;
}

export interface ArchiveSample {
  id: string;
  profile_id: string;
  title?: string;
  content?: string;
  excerpt?: string;
  tags: string[];
  images: string[];
  platform?: string;
  source_url?: string;
  sample_date?: string;
  is_featured: number;
  created_at: number;
}

const parseJsonArray = (value?: string): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const listArchiveProfiles = (): ArchiveProfile[] => {
  const stmt = db.prepare(`
    SELECT * FROM archive_profiles
    ORDER BY updated_at DESC
  `);
  return (stmt.all() as ArchiveProfile[]).map((row) => ({
    ...row,
    tone_tags: parseJsonArray(row.tone_tags as unknown as string)
  }));
};

export const createArchiveProfile = (profile: Omit<ArchiveProfile, 'created_at' | 'updated_at'>): ArchiveProfile => {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO archive_profiles (id, name, platform, goal, domain, audience, tone_tags, created_at, updated_at)
    VALUES (@id, @name, @platform, @goal, @domain, @audience, @tone_tags, @created_at, @updated_at)
  `);
  stmt.run({
    ...profile,
    tone_tags: JSON.stringify(profile.tone_tags || []),
    created_at: now,
    updated_at: now
  });
  return { ...profile, tone_tags: profile.tone_tags || [], created_at: now, updated_at: now };
};

export const updateArchiveProfile = (profile: Omit<ArchiveProfile, 'created_at' | 'updated_at'>): ArchiveProfile => {
  const now = Date.now();
  const existing = db.prepare('SELECT created_at FROM archive_profiles WHERE id = ?').get(profile.id) as { created_at?: number } | undefined;
  const createdAt = existing?.created_at ?? now;
  const stmt = db.prepare(`
    UPDATE archive_profiles
    SET name = @name,
        platform = @platform,
        goal = @goal,
        domain = @domain,
        audience = @audience,
        tone_tags = @tone_tags,
        updated_at = @updated_at
    WHERE id = @id
  `);
  stmt.run({
    ...profile,
    tone_tags: JSON.stringify(profile.tone_tags || []),
    updated_at: now
  });
  return { ...profile, created_at: createdAt, updated_at: now, tone_tags: profile.tone_tags || [] };
};

export const deleteArchiveProfile = (id: string): void => {
  const stmt = db.prepare('DELETE FROM archive_profiles WHERE id = ?');
  stmt.run(id);
};

export const listArchiveSamples = (profileId: string): ArchiveSample[] => {
  const stmt = db.prepare(`
    SELECT * FROM archive_samples
    WHERE profile_id = ?
    ORDER BY created_at DESC
  `);
  return (stmt.all(profileId) as ArchiveSample[]).map((row) => ({
    ...row,
    tags: parseJsonArray(row.tags as unknown as string),
    images: parseJsonArray(row.images as unknown as string),
    is_featured: row.is_featured ? 1 : 0
  }));
};

export const createArchiveSample = (sample: Omit<ArchiveSample, 'created_at'>): ArchiveSample => {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO archive_samples (id, profile_id, title, content, excerpt, tags, images, platform, source_url, sample_date, is_featured, created_at)
    VALUES (@id, @profile_id, @title, @content, @excerpt, @tags, @images, @platform, @source_url, @sample_date, @is_featured, @created_at)
  `);
  stmt.run({
    ...sample,
    tags: JSON.stringify(sample.tags || []),
    images: JSON.stringify(sample.images || []),
    is_featured: sample.is_featured ? 1 : 0,
    created_at: now
  });
  return { ...sample, tags: sample.tags || [], images: sample.images || [], is_featured: sample.is_featured ? 1 : 0, created_at: now };
};

export const updateArchiveSample = (sample: Omit<ArchiveSample, 'created_at'>): ArchiveSample => {
  const existing = db.prepare('SELECT created_at FROM archive_samples WHERE id = ?').get(sample.id) as { created_at?: number } | undefined;
  const createdAt = existing?.created_at ?? Date.now();
  const stmt = db.prepare(`
    UPDATE archive_samples
    SET title = @title,
        content = @content,
        excerpt = @excerpt,
        tags = @tags,
        images = @images,
        platform = @platform,
        source_url = @source_url,
        sample_date = @sample_date,
        is_featured = @is_featured
    WHERE id = @id
  `);
  stmt.run({
    ...sample,
    tags: JSON.stringify(sample.tags || []),
    images: JSON.stringify(sample.images || []),
    is_featured: sample.is_featured ? 1 : 0
  });
  return {
    ...sample,
    tags: sample.tags || [],
    images: sample.images || [],
    is_featured: sample.is_featured ? 1 : 0,
    created_at: createdAt
  };
};

export const deleteArchiveSample = (id: string): void => {
  const stmt = db.prepare('DELETE FROM archive_samples WHERE id = ?');
  stmt.run(id);
};

// ========== Chat History Functions ==========

export interface ChatSession {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  metadata?: string;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_calls?: string;
  tool_call_id?: string;
  display_content?: string;
  attachment?: string;
  timestamp: number;
}

export interface SessionTranscriptRecord {
  id: string;
  session_id: string;
  record_type: string;
  role?: string | null;
  content?: string | null;
  payload_json?: string | null;
  created_at: number;
}

export interface SessionCheckpointRecord {
  id: string;
  session_id: string;
  checkpoint_type: string;
  summary: string;
  payload_json?: string | null;
  created_at: number;
}

export interface SessionToolResultRecord {
  id: string;
  session_id: string;
  call_id: string;
  tool_name: string;
  command?: string | null;
  success: number;
  result_text?: string | null;
  summary_text?: string | null;
  prompt_text?: string | null;
  original_chars?: number | null;
  prompt_chars?: number | null;
  truncated: number;
  payload_json?: string | null;
  created_at: number;
  updated_at: number;
}

export type AgentTaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type AgentTaskNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface AgentTaskNodeRecord {
  id: string;
  type: string;
  title: string;
  status: AgentTaskNodeStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  summary?: string;
}

export interface AgentTaskCheckpointRecord {
  id: string;
  nodeId: string;
  summary: string;
  payload?: unknown;
  createdAt: number;
}

export interface AgentTaskArtifactRecord {
  id: string;
  type: string;
  label: string;
  relativePath?: string;
  absolutePath?: string;
  metadata?: unknown;
  createdAt: number;
}

export interface AgentTaskRecord {
  id: string;
  task_type: string;
  status: AgentTaskStatus;
  runtime_mode: string;
  owner_session_id?: string | null;
  intent?: string | null;
  role_id?: string | null;
  goal?: string | null;
  current_node?: string | null;
  route_json?: string | null;
  graph_json?: string | null;
  artifacts_json?: string | null;
  checkpoints_json?: string | null;
  metadata_json?: string | null;
  last_error?: string | null;
  created_at: number;
  updated_at: number;
  started_at?: number | null;
  completed_at?: number | null;
}

export interface AgentTaskTraceRecord {
  id: string;
  task_id: string;
  node_id?: string | null;
  event_type: string;
  payload_json?: string | null;
  created_at: number;
}

const safeJsonStringify = (value: unknown): string | null => {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: 'json-stringify-failed' });
  }
};

const safeJsonParse = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export interface AgentTaskInput {
  id: string;
  task_type: string;
  status: AgentTaskStatus;
  runtime_mode: string;
  owner_session_id?: string | null;
  intent?: string | null;
  role_id?: string | null;
  goal?: string | null;
  current_node?: string | null;
  route?: unknown;
  graph?: AgentTaskNodeRecord[];
  artifacts?: AgentTaskArtifactRecord[];
  checkpoints?: AgentTaskCheckpointRecord[];
  metadata?: unknown;
  last_error?: string | null;
  created_at?: number;
  updated_at?: number;
  started_at?: number | null;
  completed_at?: number | null;
}

export const createAgentTask = (input: AgentTaskInput): AgentTaskRecord => {
  const now = Date.now();
  const record: AgentTaskRecord = {
    id: input.id,
    task_type: input.task_type,
    status: input.status,
    runtime_mode: input.runtime_mode,
    owner_session_id: input.owner_session_id ?? null,
    intent: input.intent ?? null,
    role_id: input.role_id ?? null,
    goal: input.goal ?? null,
    current_node: input.current_node ?? null,
    route_json: safeJsonStringify(input.route),
    graph_json: safeJsonStringify(input.graph ?? []),
    artifacts_json: safeJsonStringify(input.artifacts ?? []),
    checkpoints_json: safeJsonStringify(input.checkpoints ?? []),
    metadata_json: safeJsonStringify(input.metadata),
    last_error: input.last_error ?? null,
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
    started_at: input.started_at ?? (input.status === 'running' ? now : null),
    completed_at: input.completed_at ?? null,
  };

  db.prepare(`
    INSERT INTO agent_tasks (
      id, task_type, status, runtime_mode, owner_session_id, intent, role_id, goal,
      current_node, route_json, graph_json, artifacts_json, checkpoints_json, metadata_json,
      last_error, created_at, updated_at, started_at, completed_at
    ) VALUES (
      @id, @task_type, @status, @runtime_mode, @owner_session_id, @intent, @role_id, @goal,
      @current_node, @route_json, @graph_json, @artifacts_json, @checkpoints_json, @metadata_json,
      @last_error, @created_at, @updated_at, @started_at, @completed_at
    )
  `).run(record);

  return record;
};

export const updateAgentTask = (id: string, updates: Partial<AgentTaskInput>): AgentTaskRecord | null => {
  const current = getAgentTask(id);
  if (!current) return null;

  const next: AgentTaskRecord = {
    ...current,
    task_type: updates.task_type ?? current.task_type,
    status: updates.status ?? current.status,
    runtime_mode: updates.runtime_mode ?? current.runtime_mode,
    owner_session_id: updates.owner_session_id === undefined ? current.owner_session_id : (updates.owner_session_id ?? null),
    intent: updates.intent === undefined ? current.intent : (updates.intent ?? null),
    role_id: updates.role_id === undefined ? current.role_id : (updates.role_id ?? null),
    goal: updates.goal === undefined ? current.goal : (updates.goal ?? null),
    current_node: updates.current_node === undefined ? current.current_node : (updates.current_node ?? null),
    route_json: updates.route === undefined ? current.route_json : safeJsonStringify(updates.route),
    graph_json: updates.graph === undefined ? current.graph_json : safeJsonStringify(updates.graph ?? []),
    artifacts_json: updates.artifacts === undefined ? current.artifacts_json : safeJsonStringify(updates.artifacts ?? []),
    checkpoints_json: updates.checkpoints === undefined ? current.checkpoints_json : safeJsonStringify(updates.checkpoints ?? []),
    metadata_json: updates.metadata === undefined ? current.metadata_json : safeJsonStringify(updates.metadata),
    last_error: updates.last_error === undefined ? current.last_error : (updates.last_error ?? null),
    updated_at: Date.now(),
    started_at: updates.started_at === undefined ? current.started_at : (updates.started_at ?? null),
    completed_at: updates.completed_at === undefined ? current.completed_at : (updates.completed_at ?? null),
  };

  db.prepare(`
    UPDATE agent_tasks
    SET task_type = @task_type,
        status = @status,
        runtime_mode = @runtime_mode,
        owner_session_id = @owner_session_id,
        intent = @intent,
        role_id = @role_id,
        goal = @goal,
        current_node = @current_node,
        route_json = @route_json,
        graph_json = @graph_json,
        artifacts_json = @artifacts_json,
        checkpoints_json = @checkpoints_json,
        metadata_json = @metadata_json,
        last_error = @last_error,
        updated_at = @updated_at,
        started_at = @started_at,
        completed_at = @completed_at
    WHERE id = @id
  `).run(next);

  return next;
};

export const getAgentTask = (id: string): AgentTaskRecord | null => {
  const row = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as AgentTaskRecord | undefined;
  return row || null;
};

export const listAgentTasks = (params?: { status?: AgentTaskStatus; ownerSessionId?: string; limit?: number }): AgentTaskRecord[] => {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params?.status) {
    conditions.push('status = ?');
    values.push(params.status);
  }
  if (params?.ownerSessionId) {
    conditions.push('owner_session_id = ?');
    values.push(params.ownerSessionId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(500, Number(params?.limit || 100)));
  const stmt = db.prepare(`
    SELECT * FROM agent_tasks
    ${where}
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `);
  return stmt.all(...values) as AgentTaskRecord[];
};

export const addAgentTaskTrace = (input: {
  id?: string;
  task_id: string;
  node_id?: string | null;
  event_type: string;
  payload?: unknown;
  created_at?: number;
}): AgentTaskTraceRecord => {
  const record: AgentTaskTraceRecord = {
    id: input.id || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    task_id: input.task_id,
    node_id: input.node_id ?? null,
    event_type: input.event_type,
    payload_json: safeJsonStringify(input.payload),
    created_at: input.created_at ?? Date.now(),
  };
  db.prepare(`
    INSERT INTO agent_task_traces (id, task_id, node_id, event_type, payload_json, created_at)
    VALUES (@id, @task_id, @node_id, @event_type, @payload_json, @created_at)
  `).run(record);
  return record;
};

export const listAgentTaskTraces = (taskId: string, limit = 500): AgentTaskTraceRecord[] => {
  const safeLimit = Math.max(1, Math.min(5000, Number(limit || 500)));
  const stmt = db.prepare(`
    SELECT * FROM agent_task_traces
    WHERE task_id = ?
    ORDER BY created_at ASC
    LIMIT ${safeLimit}
  `);
  return stmt.all(taskId) as AgentTaskTraceRecord[];
};

export const parseAgentTaskRecord = (record: AgentTaskRecord | null) => {
  if (!record) return null;
  return {
    ...record,
    route: safeJsonParse(record.route_json, null as unknown),
    graph: safeJsonParse(record.graph_json, [] as AgentTaskNodeRecord[]),
    artifacts: safeJsonParse(record.artifacts_json, [] as AgentTaskArtifactRecord[]),
    checkpoints: safeJsonParse(record.checkpoints_json, [] as AgentTaskCheckpointRecord[]),
    metadata: safeJsonParse(record.metadata_json, null as unknown),
  };
};

export const parseAgentTaskTraceRecord = (record: AgentTaskTraceRecord) => ({
  ...record,
  payload: safeJsonParse(record.payload_json, null as unknown),
});

/**
 * 创建新的聊天会话
 */
export const createChatSession = (id: string, title?: string, metadata?: Record<string, any>): ChatSession => {
  const now = Date.now();
  const metadataStr = metadata ? JSON.stringify(metadata) : null;
  const stmt = db.prepare(`
    INSERT INTO chat_sessions (id, title, created_at, updated_at, metadata)
    VALUES (@id, @title, @created_at, @updated_at, @metadata)
  `);
  stmt.run({ id, title: title || 'New Chat', created_at: now, updated_at: now, metadata: metadataStr });
  return { id, title: title || 'New Chat', created_at: now, updated_at: now, metadata: metadataStr || undefined };
};

/**
 * 根据关联文件路径获取会话
 */
export const getChatSessionByFile = (filePath: string): ChatSession | null => {
  // 简单的遍历查找，因为 SQLite JSON 查询语法可能因版本而异
  const stmt = db.prepare('SELECT * FROM chat_sessions');
  const sessions = stmt.all() as ChatSession[];

  return sessions.find(session => {
    if (!session.metadata) return false;
    try {
      const meta = JSON.parse(session.metadata);
      return meta.associatedFilePath === filePath;
    } catch {
      return false;
    }
  }) || null;
};

/**
 * 根据关联文件 ID 获取会话
 */
export const getChatSessionByFileId = (fileId: string): ChatSession | null => {
  const stmt = db.prepare('SELECT * FROM chat_sessions');
  const sessions = stmt.all() as ChatSession[];

  return sessions.find(session => {
    if (!session.metadata) return false;
    try {
      const meta = JSON.parse(session.metadata);
      return meta.associatedFileId === fileId;
    } catch {
      return false;
    }
  }) || null;
};

/**
 * 根据关联上下文 ID 获取会话 (通用)
 */
export const getChatSessionByContext = (contextId: string, contextType: string): ChatSession | null => {
  const stmt = db.prepare('SELECT * FROM chat_sessions');
  const sessions = stmt.all() as ChatSession[];

  return sessions.find(session => {
    if (!session.metadata) return false;
    try {
      const meta = JSON.parse(session.metadata);
      return meta.contextId === contextId && meta.contextType === contextType;
    } catch {
      return false;
    }
  }) || null;
};

/**
 * 更新会话元数据
 */
export const updateChatSessionMetadata = (id: string, metadata: Record<string, any>): void => {
  const stmt = db.prepare(`
    UPDATE chat_sessions SET metadata = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(JSON.stringify(metadata), Date.now(), id);
};

/**
 * 获取所有聊天会话（按更新时间倒序）
 */
export const getChatSessions = (): ChatSession[] => {
  const stmt = db.prepare(`
    SELECT * FROM chat_sessions ORDER BY updated_at DESC
  `);
  return stmt.all() as ChatSession[];
};

/**
 * 获取单个聊天会话
 */
export const getChatSession = (id: string): ChatSession | null => {
  const stmt = db.prepare('SELECT * FROM chat_sessions WHERE id = ?');
  return (stmt.get(id) as ChatSession) || null;
};

/**
 * 更新会话标题
 */
export const updateChatSessionTitle = (id: string, title: string): void => {
  const stmt = db.prepare(`
    UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(title, Date.now(), id);
};

/**
 * 删除聊天会话（级联删除消息）
 */
export const deleteChatSession = (id: string): void => {
  const stmt = db.prepare('DELETE FROM chat_sessions WHERE id = ?');
  stmt.run(id);
};

/**
 * 添加聊天消息
 */
export const addChatMessage = (message: Omit<ChatMessage, 'timestamp'> & { display_content?: string; attachment?: string }): void => {
  const stmt = db.prepare(`
    INSERT INTO chat_messages (id, session_id, role, content, tool_calls, tool_call_id, display_content, attachment, timestamp)
    VALUES (@id, @session_id, @role, @content, @tool_calls, @tool_call_id, @display_content, @attachment, @timestamp)
  `);
  // 为可选参数提供默认值，避免 "Missing named parameter" 错误
  stmt.run({
    id: message.id,
    session_id: message.session_id,
    role: message.role,
    content: message.content,
    tool_calls: message.tool_calls ?? null,
    tool_call_id: message.tool_call_id ?? null,
    display_content: message.display_content ?? null,
    attachment: message.attachment ?? null,
    timestamp: Date.now(),
  });

  // 更新会话的 updated_at
  const updateSession = db.prepare(`
    UPDATE chat_sessions SET updated_at = ? WHERE id = ?
  `);
  updateSession.run(Date.now(), message.session_id);
};

/**
 * 获取会话的所有消息
 */
export const getChatMessages = (sessionId: string): ChatMessage[] => {
  const stmt = db.prepare(`
    SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC
  `);
  return stmt.all(sessionId) as ChatMessage[];
};

/**
 * 清空会话消息
 */
export const clearChatMessages = (sessionId: string): void => {
  const stmt = db.prepare('DELETE FROM chat_messages WHERE session_id = ?');
  stmt.run(sessionId);
};

export const addSessionTranscriptRecord = (record: Omit<SessionTranscriptRecord, 'created_at'> & { created_at?: number }): SessionTranscriptRecord => {
  const createdAt = record.created_at ?? Date.now();
  db.prepare(`
    INSERT INTO session_transcript_records (id, session_id, record_type, role, content, payload_json, created_at)
    VALUES (@id, @session_id, @record_type, @role, @content, @payload_json, @created_at)
  `).run({
    id: record.id,
    session_id: record.session_id,
    record_type: record.record_type,
    role: record.role ?? null,
    content: record.content ?? null,
    payload_json: record.payload_json ?? null,
    created_at: createdAt,
  });
  return {
    id: record.id,
    session_id: record.session_id,
    record_type: record.record_type,
    role: record.role ?? null,
    content: record.content ?? null,
    payload_json: record.payload_json ?? null,
    created_at: createdAt,
  };
};

export const listSessionTranscriptRecords = (sessionId: string, limit?: number): SessionTranscriptRecord[] => {
  if (limit && limit > 0) {
    return db.prepare(`
      SELECT * FROM session_transcript_records
      WHERE session_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(sessionId, Math.floor(limit)) as SessionTranscriptRecord[];
  }
  return db.prepare(`
    SELECT * FROM session_transcript_records
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).all(sessionId) as SessionTranscriptRecord[];
};

export const addSessionCheckpoint = (record: Omit<SessionCheckpointRecord, 'created_at'> & { created_at?: number }): SessionCheckpointRecord => {
  const createdAt = record.created_at ?? Date.now();
  db.prepare(`
    INSERT INTO session_checkpoints (id, session_id, checkpoint_type, summary, payload_json, created_at)
    VALUES (@id, @session_id, @checkpoint_type, @summary, @payload_json, @created_at)
  `).run({
    id: record.id,
    session_id: record.session_id,
    checkpoint_type: record.checkpoint_type,
    summary: record.summary,
    payload_json: record.payload_json ?? null,
    created_at: createdAt,
  });
  return {
    id: record.id,
    session_id: record.session_id,
    checkpoint_type: record.checkpoint_type,
    summary: record.summary,
    payload_json: record.payload_json ?? null,
    created_at: createdAt,
  };
};

export const listSessionCheckpoints = (sessionId: string, limit?: number): SessionCheckpointRecord[] => {
  if (limit && limit > 0) {
    return db.prepare(`
      SELECT * FROM session_checkpoints
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, Math.floor(limit)) as SessionCheckpointRecord[];
  }
  return db.prepare(`
    SELECT * FROM session_checkpoints
    WHERE session_id = ?
    ORDER BY created_at DESC
  `).all(sessionId) as SessionCheckpointRecord[];
};

export const addSessionToolResult = (
  record: Omit<SessionToolResultRecord, 'created_at' | 'updated_at'> & { created_at?: number; updated_at?: number },
): SessionToolResultRecord => {
  const createdAt = record.created_at ?? Date.now();
  const updatedAt = record.updated_at ?? createdAt;
  db.prepare(`
    INSERT INTO session_tool_results (
      id, session_id, call_id, tool_name, command, success, result_text, summary_text,
      prompt_text, original_chars, prompt_chars, truncated, payload_json, created_at, updated_at
    )
    VALUES (
      @id, @session_id, @call_id, @tool_name, @command, @success, @result_text, @summary_text,
      @prompt_text, @original_chars, @prompt_chars, @truncated, @payload_json, @created_at, @updated_at
    )
  `).run({
    id: record.id,
    session_id: record.session_id,
    call_id: record.call_id,
    tool_name: record.tool_name,
    command: record.command ?? null,
    success: record.success,
    result_text: record.result_text ?? null,
    summary_text: record.summary_text ?? null,
    prompt_text: record.prompt_text ?? null,
    original_chars: record.original_chars ?? null,
    prompt_chars: record.prompt_chars ?? null,
    truncated: record.truncated,
    payload_json: record.payload_json ?? null,
    created_at: createdAt,
    updated_at: updatedAt,
  });
  return {
    ...record,
    command: record.command ?? null,
    result_text: record.result_text ?? null,
    summary_text: record.summary_text ?? null,
    prompt_text: record.prompt_text ?? null,
    original_chars: record.original_chars ?? null,
    prompt_chars: record.prompt_chars ?? null,
    payload_json: record.payload_json ?? null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
};

export const updateSessionToolResult = (
  sessionId: string,
  callId: string,
  patch: Partial<Pick<
    SessionToolResultRecord,
    'command' | 'success' | 'result_text' | 'summary_text' | 'prompt_text' | 'original_chars' | 'prompt_chars' | 'truncated' | 'payload_json'
  >>,
): SessionToolResultRecord | null => {
  const existing = db.prepare(`
    SELECT * FROM session_tool_results
    WHERE session_id = ? AND call_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(sessionId, callId) as SessionToolResultRecord | undefined;
  if (!existing) return null;
  const next: SessionToolResultRecord = {
    ...existing,
    command: patch.command !== undefined ? patch.command ?? null : existing.command,
    success: patch.success !== undefined ? patch.success : existing.success,
    result_text: patch.result_text !== undefined ? patch.result_text ?? null : existing.result_text,
    summary_text: patch.summary_text !== undefined ? patch.summary_text ?? null : existing.summary_text,
    prompt_text: patch.prompt_text !== undefined ? patch.prompt_text ?? null : existing.prompt_text,
    original_chars: patch.original_chars !== undefined ? patch.original_chars ?? null : existing.original_chars,
    prompt_chars: patch.prompt_chars !== undefined ? patch.prompt_chars ?? null : existing.prompt_chars,
    truncated: patch.truncated !== undefined ? patch.truncated : existing.truncated,
    payload_json: patch.payload_json !== undefined ? patch.payload_json ?? null : existing.payload_json,
    updated_at: Date.now(),
  };
  db.prepare(`
    UPDATE session_tool_results
    SET command = @command,
        success = @success,
        result_text = @result_text,
        summary_text = @summary_text,
        prompt_text = @prompt_text,
        original_chars = @original_chars,
        prompt_chars = @prompt_chars,
        truncated = @truncated,
        payload_json = @payload_json,
        updated_at = @updated_at
    WHERE id = @id
  `).run(next);
  return next;
};

export const listSessionToolResults = (sessionId: string, limit?: number): SessionToolResultRecord[] => {
  if (limit && limit > 0) {
    return db.prepare(`
      SELECT * FROM session_tool_results
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, Math.floor(limit)) as SessionToolResultRecord[];
  }
  return db.prepare(`
    SELECT * FROM session_tool_results
    WHERE session_id = ?
    ORDER BY created_at DESC
  `).all(sessionId) as SessionToolResultRecord[];
};

export const cloneChatSession = (sourceSessionId: string, nextSessionId: string, title?: string): ChatSession => {
  const source = getChatSession(sourceSessionId);
  if (!source) {
    throw new Error(`Source chat session not found: ${sourceSessionId}`);
  }

  const parsedMetadata = source.metadata ? safeJsonParse(source.metadata, {} as Record<string, unknown>) : {};
  const cloned = createChatSession(nextSessionId, title || source.title, parsedMetadata);
  const messages = getChatMessages(sourceSessionId);
  const transcript = listSessionTranscriptRecords(sourceSessionId);
  const checkpoints = listSessionCheckpoints(sourceSessionId);

  for (const message of messages) {
    addChatMessage({
      id: `${message.id}_fork_${Math.random().toString(36).slice(2, 8)}`,
      session_id: nextSessionId,
      role: message.role,
      content: message.content,
      tool_calls: message.tool_calls,
      tool_call_id: message.tool_call_id,
      display_content: message.display_content,
      attachment: message.attachment,
    });
  }

  for (const item of transcript) {
    addSessionTranscriptRecord({
      id: `${item.id}_fork_${Math.random().toString(36).slice(2, 8)}`,
      session_id: nextSessionId,
      record_type: item.record_type,
      role: item.role ?? undefined,
      content: item.content ?? undefined,
      payload_json: item.payload_json ?? undefined,
    });
  }

  for (const checkpoint of checkpoints) {
    addSessionCheckpoint({
      id: `${checkpoint.id}_fork_${Math.random().toString(36).slice(2, 8)}`,
      session_id: nextSessionId,
      checkpoint_type: checkpoint.checkpoint_type,
      summary: checkpoint.summary,
      payload_json: checkpoint.payload_json ?? undefined,
    });
  }

  return cloned;
};

// ========== Manuscript Embedding Cache ==========

// Create manuscript_embeddings table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS manuscript_embeddings (
      file_path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
} catch { /* Table already exists */ }

export interface ManuscriptEmbedding {
  file_path: string;
  content_hash: string;
  embedding: Buffer;
  created_at: number;
}

export const getManuscriptEmbedding = (filePath: string): { embedding: number[]; contentHash: string } | null => {
  const stmt = db.prepare('SELECT content_hash, embedding FROM manuscript_embeddings WHERE file_path = ?');
  const row = stmt.get(filePath) as { content_hash: string; embedding: Buffer } | undefined;
  if (!row) return null;

  // Convert Buffer to number array
  const floatArray = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  return {
    embedding: Array.from(floatArray),
    contentHash: row.content_hash
  };
};

export const saveManuscriptEmbedding = (filePath: string, contentHash: string, embedding: number[]): void => {
  const stmt = db.prepare(`
    INSERT INTO manuscript_embeddings (file_path, content_hash, embedding, created_at)
    VALUES (@file_path, @content_hash, @embedding, @created_at)
    ON CONFLICT(file_path) DO UPDATE SET
      content_hash = @content_hash,
      embedding = @embedding,
      created_at = @created_at
  `);

  // Convert number array to Buffer
  const floatArray = new Float32Array(embedding);
  const buffer = Buffer.from(floatArray.buffer);

  stmt.run({
    file_path: filePath,
    content_hash: contentHash,
    embedding: buffer,
    created_at: Date.now()
  });
};

export const deleteManuscriptEmbedding = (filePath: string): void => {
  const stmt = db.prepare('DELETE FROM manuscript_embeddings WHERE file_path = ?');
  stmt.run(filePath);
};

// ========== Manuscript Similarity Cache ==========

// Create manuscript_similarity_cache table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS manuscript_similarity_cache (
      manuscript_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      knowledge_version INTEGER NOT NULL,
      sorted_ids TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
} catch { /* Table already exists */ }

// 知识库版本号（每次知识库变化时递增）
let knowledgeVersion = Date.now();

export const getKnowledgeVersion = (): number => knowledgeVersion;

export const incrementKnowledgeVersion = (): number => {
  knowledgeVersion = Date.now();
  return knowledgeVersion;
};

export interface SimilarityCache {
  manuscriptId: string;
  contentHash: string;
  knowledgeVersion: number;
  sortedIds: string[];
  createdAt: number;
}

export const getSimilarityCache = (manuscriptId: string): SimilarityCache | null => {
  const stmt = db.prepare('SELECT * FROM manuscript_similarity_cache WHERE manuscript_id = ?');
  const row = stmt.get(manuscriptId) as any;
  if (!row) return null;

  return {
    manuscriptId: row.manuscript_id,
    contentHash: row.content_hash,
    knowledgeVersion: row.knowledge_version,
    sortedIds: JSON.parse(row.sorted_ids),
    createdAt: row.created_at
  };
};

export const saveSimilarityCache = (cache: Omit<SimilarityCache, 'createdAt'>): void => {
  const stmt = db.prepare(`
    INSERT INTO manuscript_similarity_cache (manuscript_id, content_hash, knowledge_version, sorted_ids, created_at)
    VALUES (@manuscript_id, @content_hash, @knowledge_version, @sorted_ids, @created_at)
    ON CONFLICT(manuscript_id) DO UPDATE SET
      content_hash = @content_hash,
      knowledge_version = @knowledge_version,
      sorted_ids = @sorted_ids,
      created_at = @created_at
  `);

  stmt.run({
    manuscript_id: cache.manuscriptId,
    content_hash: cache.contentHash,
    knowledge_version: cache.knowledgeVersion,
    sorted_ids: JSON.stringify(cache.sortedIds),
    created_at: Date.now()
  });
};

export const deleteSimilarityCache = (manuscriptId: string): void => {
  const stmt = db.prepare('DELETE FROM manuscript_similarity_cache WHERE manuscript_id = ?');
  stmt.run(manuscriptId);
};

// ========== Document Knowledge Index ==========

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_knowledge_index (
      space_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      absolute_path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      title TEXT,
      file_size INTEGER NOT NULL DEFAULT 0,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (space_id, source_id, absolute_path)
    );
    CREATE INDEX IF NOT EXISTS idx_doc_index_space_source ON document_knowledge_index(space_id, source_id);
  `);
} catch { /* Table already exists */ }

export interface DocumentKnowledgeIndexEntry {
  sourceId: string;
  absolutePath: string;
  relativePath: string;
  title?: string;
  fileSize: number;
  mtimeMs: number;
  updatedAt: number;
}

const normalizeDocumentIndexEntry = (item: DocumentKnowledgeIndexEntry) => ({
  source_id: item.sourceId,
  absolute_path: item.absolutePath,
  relative_path: item.relativePath,
  title: item.title || '',
  file_size: Number.isFinite(item.fileSize) ? Math.max(0, Math.floor(item.fileSize)) : 0,
  mtime_ms: Number.isFinite(item.mtimeMs) ? Math.max(0, Math.floor(item.mtimeMs)) : 0,
  updated_at: Number.isFinite(item.updatedAt) ? Math.floor(item.updatedAt) : Date.now(),
});

export const replaceDocumentKnowledgeIndexForSource = (sourceId: string, entries: DocumentKnowledgeIndexEntry[], spaceId?: string): void => {
  const scopedSpaceId = resolveSpaceId(spaceId);
  const normalized = entries.map(normalizeDocumentIndexEntry);

  const deleteStmt = db.prepare('DELETE FROM document_knowledge_index WHERE space_id = ? AND source_id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO document_knowledge_index (
      space_id, source_id, absolute_path, relative_path, title, file_size, mtime_ms, updated_at
    ) VALUES (
      @space_id, @source_id, @absolute_path, @relative_path, @title, @file_size, @mtime_ms, @updated_at
    )
  `);

  const tx = db.transaction(() => {
    deleteStmt.run(scopedSpaceId, sourceId);
    for (const entry of normalized) {
      insertStmt.run({
        space_id: scopedSpaceId,
        ...entry,
      });
    }
  });
  tx();
};

export const listDocumentKnowledgeIndexEntries = (sourceId: string, limit?: number, spaceId?: string): DocumentKnowledgeIndexEntry[] => {
  const scopedSpaceId = resolveSpaceId(spaceId);
  const hasLimit = Number.isFinite(Number(limit)) && Number(limit) > 0;
  const stmt = hasLimit
    ? db.prepare(`
      SELECT source_id, absolute_path, relative_path, title, file_size, mtime_ms, updated_at
      FROM document_knowledge_index
      WHERE space_id = ? AND source_id = ?
      ORDER BY relative_path ASC
      LIMIT ?
    `)
    : db.prepare(`
      SELECT source_id, absolute_path, relative_path, title, file_size, mtime_ms, updated_at
      FROM document_knowledge_index
      WHERE space_id = ? AND source_id = ?
      ORDER BY relative_path ASC
    `);

  const rows = (hasLimit
    ? stmt.all(scopedSpaceId, sourceId, Math.floor(Number(limit)))
    : stmt.all(scopedSpaceId, sourceId)) as Array<{
      source_id: string;
      absolute_path: string;
      relative_path: string;
      title?: string;
      file_size: number;
      mtime_ms: number;
      updated_at: number;
    }>;

  return rows.map((row) => ({
    sourceId: row.source_id,
    absolutePath: row.absolute_path,
    relativePath: row.relative_path,
    title: row.title || '',
    fileSize: Number(row.file_size || 0),
    mtimeMs: Number(row.mtime_ms || 0),
    updatedAt: Number(row.updated_at || 0),
  }));
};

export const getDocumentKnowledgeIndexSummary = (spaceId?: string): Array<{ sourceId: string; fileCount: number; updatedAt: number }> => {
  const scopedSpaceId = resolveSpaceId(spaceId);
  const rows = db.prepare(`
    SELECT source_id, COUNT(*) AS file_count, MAX(updated_at) AS updated_at
    FROM document_knowledge_index
    WHERE space_id = ?
    GROUP BY source_id
  `).all(scopedSpaceId) as Array<{ source_id: string; file_count: number; updated_at: number }>;

  return rows.map((row) => ({
    sourceId: row.source_id,
    fileCount: Number(row.file_count || 0),
    updatedAt: Number(row.updated_at || 0),
  }));
};

// ========== Wander History Functions ==========

export interface WanderHistory {
  id: string;
  space_id?: string;
  items: string; // JSON array of WanderItem
  result: string; // JSON of WanderResult
  created_at: number;
}

// Create wander_history table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wander_history (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL DEFAULT '${DEFAULT_SPACE_ID}',
      items TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wander_history_created_at ON wander_history(created_at);
  `);
} catch { /* Table already exists */ }

try {
  db.exec(`ALTER TABLE wander_history ADD COLUMN space_id TEXT;`);
} catch { /* Column already exists */ }
if (hasColumn('wander_history', 'space_id')) {
  db.exec(`
    UPDATE wander_history
    SET space_id = COALESCE(
      (SELECT NULLIF(active_space_id, '') FROM settings WHERE id = 1),
      '${DEFAULT_SPACE_ID}'
    )
    WHERE space_id IS NULL OR space_id = ''
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wander_history_space_created_at ON wander_history(space_id, created_at);`);
}

export const saveWanderHistory = (id: string, items: any[], result: any): WanderHistory => {
  const now = Date.now();
  const scopedSpaceId = resolveSpaceId();
  const stmt = db.prepare(`
    INSERT INTO wander_history (id, space_id, items, result, created_at)
    VALUES (@id, @space_id, @items, @result, @created_at)
  `);
  stmt.run({
    id,
    space_id: scopedSpaceId,
    items: JSON.stringify(items),
    result: JSON.stringify(result),
    created_at: now
  });
  return { id, space_id: scopedSpaceId, items: JSON.stringify(items), result: JSON.stringify(result), created_at: now };
};

export const listWanderHistory = (): WanderHistory[] => {
  const stmt = db.prepare('SELECT * FROM wander_history WHERE space_id = ? ORDER BY created_at DESC');
  return stmt.all(resolveSpaceId()) as WanderHistory[];
};

export const getWanderHistory = (id: string): WanderHistory | null => {
  const stmt = db.prepare('SELECT * FROM wander_history WHERE id = ? AND space_id = ?');
  return (stmt.get(id, resolveSpaceId()) as WanderHistory) || null;
};

export const deleteWanderHistory = (id: string): void => {
  const stmt = db.prepare('DELETE FROM wander_history WHERE id = ? AND space_id = ?');
  stmt.run(id, resolveSpaceId());
};

// ========== Vector Store Functions ==========

export interface KnowledgeVector {
  id: string;
  source_id: string;
  source_type: 'note' | 'video' | 'file';
  chunk_index: number;
  content: string;
  embedding: Buffer; // Stored as BLOB
  metadata?: Record<string, any>;
  content_hash?: string;
  created_at?: string;
}

const isVectorInSpace = (metadata: Record<string, any> | undefined, activeSpaceId: string): boolean => {
  const vectorSpaceId = metadata?.spaceId;
  if (!vectorSpaceId) {
    return activeSpaceId === DEFAULT_SPACE_ID;
  }
  return vectorSpaceId === activeSpaceId;
};

export const upsertVectors = (vectors: Omit<KnowledgeVector, 'created_at'>[]): void => {
  const insert = db.prepare(`
    INSERT INTO knowledge_vectors (id, source_id, source_type, chunk_index, content, embedding, metadata, content_hash)
    VALUES (@id, @source_id, @source_type, @chunk_index, @content, @embedding, @metadata, @content_hash)
    ON CONFLICT(id) DO UPDATE SET
      content = @content,
      embedding = @embedding,
      metadata = @metadata,
      content_hash = @content_hash
  `);

  const transaction = db.transaction((vectors) => {
    for (const v of vectors) {
      insert.run({
        ...v,
        metadata: v.metadata ? JSON.stringify(v.metadata) : null,
        content_hash: v.content_hash || null
      });
    }
  });

  transaction(vectors);
};

export const deleteVectors = (sourceId: string): void => {
  const activeSpaceId = getActiveSpaceId();
  const rows = db.prepare('SELECT id, metadata FROM knowledge_vectors WHERE source_id = ?').all(sourceId) as { id: string; metadata?: string }[];
  const removeStmt = db.prepare('DELETE FROM knowledge_vectors WHERE id = ?');
  const transaction = db.transaction((candidates: { id: string; metadata?: string }[]) => {
    for (const row of candidates) {
      let metadata: Record<string, any> | undefined;
      try {
        metadata = row.metadata ? JSON.parse(row.metadata) : undefined;
      } catch {
        metadata = undefined;
      }
      if (isVectorInSpace(metadata, activeSpaceId)) {
        removeStmt.run(row.id);
      }
    }
  });
  transaction(rows);
};

export const getVectorHash = (sourceId: string): string | null => {
  const activeSpaceId = getActiveSpaceId();
  const rows = db.prepare('SELECT content_hash, metadata FROM knowledge_vectors WHERE source_id = ?').all(sourceId) as { content_hash?: string; metadata?: string }[];
  for (const row of rows) {
    let metadata: Record<string, any> | undefined;
    try {
      metadata = row.metadata ? JSON.parse(row.metadata) : undefined;
    } catch {
      metadata = undefined;
    }
    if (isVectorInSpace(metadata, activeSpaceId)) {
      return row.content_hash || null;
    }
  }
  return null;
};

export const getAllVectors = (): KnowledgeVector[] => {
  const activeSpaceId = getActiveSpaceId();
  const stmt = db.prepare('SELECT * FROM knowledge_vectors');
  return (stmt.all() as any[])
    .map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    }))
    .filter(row => isVectorInSpace(row.metadata, activeSpaceId));
};

export const getVectorStats = () => {
  const vectors = getAllVectors();
  const sourceIds = new Set(vectors.map(v => v.source_id));
  return {
    totalVectors: vectors.length,
    totalDocuments: sourceIds.size
  };
};

export const clearAllVectors = () => {
  db.exec('DELETE FROM knowledge_vectors');
};

// ========== File Index Lane & Event Queries ==========

export interface FileIndexLaneRow {
  id: string;
  scope_id: string;
  lane: string;
  status: string;
  done: number;
  total: number;
  failed: number;
  metadata_only: number;
  last_updated_at: string | null;
  next_retry_at: string | null;
}

export const getFileIndexLanesByScope = (scopeId: string) => {
  const stmt = db.prepare(
    'SELECT * FROM file_index_lanes WHERE scope_id = ?'
  );
  return stmt.all(scopeId) as FileIndexLaneRow[];
};

export const getAllFileIndexLanes = () => {
  const stmt = db.prepare('SELECT * FROM file_index_lanes');
  return stmt.all() as FileIndexLaneRow[];
};

export const upsertFileIndexLane = (lane: {
  id: string;
  scope_id: string;
  lane: string;
  status?: string;
  done?: number;
  total?: number;
  failed?: number;
  metadata_only?: number;
  last_updated_at?: string | null;
  next_retry_at?: string | null;
}) => {
  const stmt = db.prepare(`
    INSERT INTO file_index_lanes (id, scope_id, lane, status, done, total, failed, metadata_only, last_updated_at, next_retry_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      done = excluded.done,
      total = excluded.total,
      failed = excluded.failed,
      metadata_only = excluded.metadata_only,
      last_updated_at = excluded.last_updated_at,
      next_retry_at = excluded.next_retry_at
  `);
  return stmt.run(
    lane.id,
    lane.scope_id,
    lane.lane,
    lane.status ?? 'idle',
    lane.done ?? 0,
    lane.total ?? 0,
    lane.failed ?? 0,
    lane.metadata_only ?? 0,
    lane.last_updated_at ?? null,
    lane.next_retry_at ?? null,
  );
};

export const addFileIndexEvent = (event: {
  id: string;
  source_id: string;
  event_type: string;
  details?: string | null;
}) => {
  const stmt = db.prepare(`
    INSERT INTO file_index_events (id, source_id, event_type, details)
    VALUES (?, ?, ?, ?)
  `);
  return stmt.run(event.id, event.source_id, event.event_type, event.details ?? null);
};

export const getFileIndexEventsBySource = (sourceId: string, limit = 20) => {
  const stmt = db.prepare(
    'SELECT * FROM file_index_events WHERE source_id = ? ORDER BY created_at DESC LIMIT ?'
  );
  return stmt.all(sourceId, limit);
};

// ========== Vector Search Logic (In-Memory Cosine Similarity) ==========

/**
 * 计算两个向量的余弦相似度
 */
function cosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
  if (vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  metadata: any;
  sourceId: string;
}

/**
 * 纯向量检索
 * @param queryEmbedding 查询向量
 * @param limit 返回数量
 * @param filter 过滤条件 (advisorId)
 */
export const searchVectors = (
  queryEmbedding: number[],
  limit: number = 5,
  filter?: { advisorId?: string; scope?: 'user' | 'advisor' }
): SearchResult[] => {
  const activeSpaceId = getActiveSpaceId();
  // 1. 获取所有向量 (或者根据 source_type 初步过滤以减少计算量)
  // 为了性能，我们尽量只读取必要的字段。embedding 是 BLOB。
  const stmt = db.prepare('SELECT id, content, embedding, metadata, source_id FROM knowledge_vectors');
  const rows = stmt.all() as any[];

  const queryVec = new Float32Array(queryEmbedding);
  const results: SearchResult[] = [];

  for (const row of rows) {
    // Parse metadata to check filters
    let metadata: any = {};
    try {
      metadata = row.metadata ? JSON.parse(row.metadata) : {};
    } catch {}

    // Apply filters
    if (filter) {
      if (filter.advisorId && metadata.advisorId !== filter.advisorId) continue;
      // if (filter.scope && metadata.scope !== filter.scope) continue; // Optional scope filter
    }
    if (!isVectorInSpace(metadata, activeSpaceId)) continue;

    // Convert Buffer back to Float32Array
    const embedding = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);

    // Calculate similarity
    const score = cosineSimilarity(queryVec, embedding);

    // Threshold (optional, e.g. > 0.7)
    if (score > 0.5) {
      results.push({
        id: row.id,
        content: row.content,
        score,
        metadata,
        sourceId: row.source_id
      });
    }
  }

  // Sort by score desc
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
};

/**
 * 获取所有知识库条目的相似度排序
 * @param queryEmbedding 查询向量
 * @returns 按相似度排序的 source_id 列表
 */
export const getSimilaritySortedSourceIds = (queryEmbedding: number[]): { sourceId: string; score: number }[] => {
  const activeSpaceId = getActiveSpaceId();
  const stmt = db.prepare('SELECT source_id, embedding, metadata FROM knowledge_vectors');
  const rows = stmt.all() as any[];

  const queryVec = new Float32Array(queryEmbedding);
  const sourceScores = new Map<string, number>();

  for (const row of rows) {
    if (!row.embedding) continue;
    let metadata: any = {};
    try {
      metadata = row.metadata ? JSON.parse(row.metadata) : {};
    } catch {}
    if (!isVectorInSpace(metadata, activeSpaceId)) continue;

    // Convert Buffer back to Float32Array
    const embedding = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);

    // Calculate similarity
    const score = cosineSimilarity(queryVec, embedding);

    // Keep max score for each source
    const existing = sourceScores.get(row.source_id) || 0;
    if (score > existing) {
      sourceScores.set(row.source_id, score);
    }
  }

  // Sort by score desc
  return Array.from(sourceScores.entries())
    .map(([sourceId, score]) => ({ sourceId, score }))
    .sort((a, b) => b.score - a.score);
};
