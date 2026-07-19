import 'server-only'
import path from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'

export interface AudioFileIdentityInput {
  name: string
  relativePath: string
  size: number
  lastModified: number
}

export interface SyncedLibraryItem extends AudioFileIdentityInput {
  identityKey: string
  maxReadyMinutes: number
  hasFullPreview: boolean
  lastGeneratedAt: string | null
}

export interface LibrarySourceInput {
  sourceType: string
  sourceLabel?: string | null
  deviceLabel?: string | null
}

export interface StoredLibrarySource {
  sourceType: string
  sourceLabel: string | null
  deviceLabel: string | null
  lastSyncedAt: string
}

export interface PairingSession {
  pairingToken: string
  expiresAt: string
}

export type PairingCompletionResult =
  | { status: 'paired'; ownerToken: string }
  | { status: 'invalid' | 'expired' | 'used' }

export interface StoredChunkRow {
  minuteIndex: number
  status: 'done' | 'error'
  text: string | null
  error: string | null
  updatedAt: string
}

const DB_DIR = path.join(process.cwd(), '.data')
const DB_PATH = path.join(DB_DIR, 'shiur-reader.sqlite')

let db: Database.Database | null = null

function getDb(): Database.Database {
  if (db) {
    return db
  }

  fs.mkdirSync(DB_DIR, { recursive: true })
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS audio_files (
      identity_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      last_modified INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS minute_chunks (
      identity_key TEXT NOT NULL,
      minute_index INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('done', 'error')),
      text TEXT,
      error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (identity_key, minute_index),
      FOREIGN KEY(identity_key) REFERENCES audio_files(identity_key) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS owner_library_files (
      owner_token TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      last_modified INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner_token, identity_key),
      FOREIGN KEY(identity_key) REFERENCES audio_files(identity_key) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS owner_sources (
      owner_token TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_label TEXT,
      device_label TEXT,
      last_synced_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pairing_sessions (
      pairing_token TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
  `)

  return db
}

function normalizePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').trim()
}

export function buildIdentityKey(file: AudioFileIdentityInput): string {
  const normalizedRelativePath = normalizePath(file.relativePath)
  return `${normalizedRelativePath}::${file.size}`
}

function buildLegacyIdentityKey(file: AudioFileIdentityInput): string {
  const normalizedRelativePath = normalizePath(file.relativePath)
  return `${normalizedRelativePath}::${file.size}::${file.lastModified}`
}

export function getIdentityKeyForFile(file: AudioFileIdentityInput): string {
  const database = getDb()
  const normalizedRelativePath = normalizePath(file.relativePath)
  const stableKey = buildIdentityKey(file)
  const legacyKey = buildLegacyIdentityKey(file)

  const byStable = database.prepare(`
    SELECT identity_key
    FROM audio_files
    WHERE identity_key = ?
    LIMIT 1
  `).get(stableKey) as { identity_key: string } | undefined

  if (byStable?.identity_key) {
    return byStable.identity_key
  }

  const byPathAndSize = database.prepare(`
    SELECT identity_key
    FROM audio_files
    WHERE relative_path = ? AND size = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(normalizedRelativePath, file.size) as { identity_key: string } | undefined

  if (byPathAndSize?.identity_key) {
    return byPathAndSize.identity_key
  }

  const byLegacy = database.prepare(`
    SELECT identity_key
    FROM audio_files
    WHERE identity_key = ?
    LIMIT 1
  `).get(legacyKey) as { identity_key: string } | undefined

  if (byLegacy?.identity_key) {
    return byLegacy.identity_key
  }

  return stableKey
}

export function upsertAudioFiles(files: AudioFileIdentityInput[]): void {
  if (files.length === 0) {
    return
  }

  const database = getDb()
  const now = new Date().toISOString()

  const stmt = database.prepare(`
    INSERT INTO audio_files (identity_key, name, relative_path, size, last_modified, updated_at)
    VALUES (@identity_key, @name, @relative_path, @size, @last_modified, @updated_at)
    ON CONFLICT(identity_key) DO UPDATE SET
      name = excluded.name,
      relative_path = excluded.relative_path,
      size = excluded.size,
      last_modified = excluded.last_modified,
      updated_at = excluded.updated_at
  `)

  const tx = database.transaction((rows: AudioFileIdentityInput[]) => {
    for (const row of rows) {
      const identityKey = getIdentityKeyForFile(row)
      stmt.run({
        identity_key: identityKey,
        name: row.name,
        relative_path: normalizePath(row.relativePath),
        size: row.size,
        last_modified: row.lastModified,
        updated_at: now,
      })
    }
  })

  tx(files)
}

function buildLibraryItem(
  row: {
    identity_key: string
    name: string
    relative_path: string
    size: number
    last_modified: number
  },
  previewLength: number
): SyncedLibraryItem {
  const maxReadyMinutes = getContiguousReadyMinutes(row.identity_key, previewLength)

  return {
    identityKey: row.identity_key,
    name: row.name,
    relativePath: row.relative_path,
    size: row.size,
    lastModified: row.last_modified,
    maxReadyMinutes,
    hasFullPreview: maxReadyMinutes >= previewLength,
    lastGeneratedAt: getLastGeneratedAt(row.identity_key),
  }
}

function normalizeLibrarySource(source: LibrarySourceInput | null | undefined): LibrarySourceInput | null {
  if (!source) {
    return null
  }

  const sourceType = source.sourceType.trim()

  if (!sourceType) {
    return null
  }

  return {
    sourceType,
    sourceLabel: source.sourceLabel?.trim() || null,
    deviceLabel: source.deviceLabel?.trim() || null,
  }
}

export function replaceOwnerLibrary(
  ownerToken: string,
  files: AudioFileIdentityInput[],
  source?: LibrarySourceInput | null
): void {
  const database = getDb()
  const now = new Date().toISOString()
  const normalizedSource = normalizeLibrarySource(source)
  const dedupedByIdentity = new Map<string, AudioFileIdentityInput>()

  for (const file of files) {
    const normalized: AudioFileIdentityInput = {
      ...file,
      relativePath: normalizePath(file.relativePath),
    }
    dedupedByIdentity.set(getIdentityKeyForFile(normalized), normalized)
  }

  upsertAudioFiles(Array.from(dedupedByIdentity.values()))

  const insertLibraryFile = database.prepare(`
    INSERT INTO owner_library_files (
      owner_token,
      identity_key,
      name,
      relative_path,
      size,
      last_modified,
      updated_at
    )
    VALUES (
      @owner_token,
      @identity_key,
      @name,
      @relative_path,
      @size,
      @last_modified,
      @updated_at
    )
  `)

  const upsertSource = database.prepare(`
    INSERT INTO owner_sources (
      owner_token,
      source_type,
      source_label,
      device_label,
      last_synced_at,
      updated_at
    )
    VALUES (
      @owner_token,
      @source_type,
      @source_label,
      @device_label,
      @last_synced_at,
      @updated_at
    )
    ON CONFLICT(owner_token) DO UPDATE SET
      source_type = excluded.source_type,
      source_label = excluded.source_label,
      device_label = excluded.device_label,
      last_synced_at = excluded.last_synced_at,
      updated_at = excluded.updated_at
  `)

  const tx = database.transaction(() => {
    database.prepare(`
      DELETE FROM owner_library_files
      WHERE owner_token = ?
    `).run(ownerToken)

    for (const [identityKey, file] of dedupedByIdentity.entries()) {
      insertLibraryFile.run({
        owner_token: ownerToken,
        identity_key: identityKey,
        name: file.name,
        relative_path: file.relativePath,
        size: file.size,
        last_modified: file.lastModified,
        updated_at: now,
      })
    }

    if (normalizedSource) {
      upsertSource.run({
        owner_token: ownerToken,
        source_type: normalizedSource.sourceType,
        source_label: normalizedSource.sourceLabel,
        device_label: normalizedSource.deviceLabel,
        last_synced_at: now,
        updated_at: now,
      })
    }
  })

  tx()
}

export function getOwnerLibrarySource(ownerToken: string): StoredLibrarySource | null {
  const database = getDb()
  const row = database.prepare(`
    SELECT source_type, source_label, device_label, last_synced_at
    FROM owner_sources
    WHERE owner_token = ?
    LIMIT 1
  `).get(ownerToken) as {
    source_type: string
    source_label: string | null
    device_label: string | null
    last_synced_at: string
  } | undefined

  if (!row) {
    return null
  }

  return {
    sourceType: row.source_type,
    sourceLabel: row.source_label,
    deviceLabel: row.device_label,
    lastSyncedAt: row.last_synced_at,
  }
}

export function getOwnerLibraryItemsWithStatus(
  ownerToken: string,
  previewLength: number
): SyncedLibraryItem[] {
  const database = getDb()
  const rows = database.prepare(`
    SELECT identity_key, name, relative_path, size, last_modified
    FROM owner_library_files
    WHERE owner_token = ?
    ORDER BY relative_path ASC
  `).all(ownerToken) as Array<{
    identity_key: string
    name: string
    relative_path: string
    size: number
    last_modified: number
  }>

  return rows.map((row) => buildLibraryItem(row, previewLength))
}

export function createPairingSession(
  ownerToken: string,
  pairingToken: string,
  ttlMs: number
): PairingSession {
  const database = getDb()
  const createdAt = new Date()
  const expiresAt = new Date(createdAt.getTime() + ttlMs)

  database.prepare(`
    INSERT INTO pairing_sessions (
      pairing_token,
      owner_token,
      created_at,
      expires_at,
      used_at
    )
    VALUES (?, ?, ?, ?, NULL)
  `).run(
    pairingToken,
    ownerToken,
    createdAt.toISOString(),
    expiresAt.toISOString()
  )

  return {
    pairingToken,
    expiresAt: expiresAt.toISOString(),
  }
}

export function consumePairingSession(pairingToken: string): PairingCompletionResult {
  const database = getDb()
  const now = new Date().toISOString()

  const tx = database.transaction((token: string): PairingCompletionResult => {
    const row = database.prepare(`
      SELECT owner_token, expires_at, used_at
      FROM pairing_sessions
      WHERE pairing_token = ?
      LIMIT 1
    `).get(token) as {
      owner_token: string
      expires_at: string
      used_at: string | null
    } | undefined

    if (!row) {
      return { status: 'invalid' }
    }

    if (row.used_at) {
      return { status: 'used' }
    }

    if (row.expires_at <= now) {
      return { status: 'expired' }
    }

    database.prepare(`
      UPDATE pairing_sessions
      SET used_at = ?
      WHERE pairing_token = ?
    `).run(now, token)

    return {
      status: 'paired',
      ownerToken: row.owner_token,
    }
  })

  return tx(pairingToken)
}

function getContiguousReadyMinutes(identityKey: string, upToMinutes: number): number {
  const database = getDb()
  const rows = database.prepare(`
    SELECT minute_index, status
    FROM minute_chunks
    WHERE identity_key = ? AND minute_index <= ?
    ORDER BY minute_index ASC
  `).all(identityKey, upToMinutes) as Array<{ minute_index: number; status: 'done' | 'error' }>

  let expectedMinute = 1
  for (const row of rows) {
    if (row.minute_index !== expectedMinute || row.status !== 'done') {
      break
    }
    expectedMinute++
  }

  return expectedMinute - 1
}

function getLastGeneratedAt(identityKey: string): string | null {
  const database = getDb()
  const row = database.prepare(`
    SELECT MAX(updated_at) AS last_generated_at
    FROM minute_chunks
    WHERE identity_key = ?
  `).get(identityKey) as { last_generated_at: string | null } | undefined

  return row?.last_generated_at ?? null
}

export function getLibraryItemsWithStatus(previewLength: number): SyncedLibraryItem[] {
  const database = getDb()

  const rows = database.prepare(`
    SELECT identity_key, name, relative_path, size, last_modified
    FROM audio_files
    ORDER BY relative_path ASC
  `).all() as Array<{
    identity_key: string
    name: string
    relative_path: string
    size: number
    last_modified: number
  }>

  return rows.map((row) => buildLibraryItem(row, previewLength))
}

export function getLibraryItemsWithStatusForFiles(
  files: AudioFileIdentityInput[],
  previewLength: number
): SyncedLibraryItem[] {
  const dedupedByIdentity = new Map<string, AudioFileIdentityInput>()

  for (const file of files) {
    const normalized: AudioFileIdentityInput = {
      ...file,
      relativePath: normalizePath(file.relativePath),
    }
    dedupedByIdentity.set(getIdentityKeyForFile(normalized), normalized)
  }

  const items: SyncedLibraryItem[] = []

  for (const [identityKey, file] of dedupedByIdentity.entries()) {
    items.push(buildLibraryItem({
      identity_key: identityKey,
      name: file.name,
      relative_path: file.relativePath,
      size: file.size,
      last_modified: file.lastModified,
    }, previewLength))
  }

  items.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return items
}

export function getReusePlan(identityKey: string, previewLength: number): {
  readyMinutes: number
  reusedChunks: Array<{ minuteIndex: number; text: string | null }>
} {
  const database = getDb()
  const rows = database.prepare(`
    SELECT minute_index, status, text
    FROM minute_chunks
    WHERE identity_key = ? AND minute_index <= ?
    ORDER BY minute_index ASC
  `).all(identityKey, previewLength) as Array<{ minute_index: number; status: 'done' | 'error'; text: string | null }>

  const reusedChunks: Array<{ minuteIndex: number; text: string | null }> = []
  let expectedMinute = 1

  for (const row of rows) {
    if (row.minute_index !== expectedMinute || row.status !== 'done') {
      break
    }

    reusedChunks.push({ minuteIndex: row.minute_index, text: row.text })
    expectedMinute++
  }

  return {
    readyMinutes: expectedMinute - 1,
    reusedChunks,
  }
}

export function getChunksForPreview(identityKey: string, previewLength: number): StoredChunkRow[] {
  const database = getDb()

  const rows = database.prepare(`
    SELECT minute_index, status, text, error, updated_at
    FROM minute_chunks
    WHERE identity_key = ? AND minute_index <= ?
    ORDER BY minute_index ASC
  `).all(identityKey, previewLength) as Array<{
    minute_index: number
    status: 'done' | 'error'
    text: string | null
    error: string | null
    updated_at: string
  }>

  return rows.map((row) => ({
    minuteIndex: row.minute_index,
    status: row.status,
    text: row.text,
    error: row.error,
    updatedAt: row.updated_at,
  }))
}

export function saveMinuteChunk(
  identityKey: string,
  minuteIndex: number,
  status: 'done' | 'error',
  text?: string,
  error?: string
): void {
  const database = getDb()
  const now = new Date().toISOString()

  database.prepare(`
    INSERT INTO minute_chunks (identity_key, minute_index, status, text, error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(identity_key, minute_index) DO UPDATE SET
      status = excluded.status,
      text = excluded.text,
      error = excluded.error,
      updated_at = excluded.updated_at
  `).run(identityKey, minuteIndex, status, text ?? null, error ?? null, now)
}
