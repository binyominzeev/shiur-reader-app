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
  `)

  return db
}

function normalizePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').trim()
}

export function buildIdentityKey(file: AudioFileIdentityInput): string {
  const normalizedRelativePath = normalizePath(file.relativePath)
  return `${normalizedRelativePath}::${file.size}::${file.lastModified}`
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
      stmt.run({
        identity_key: buildIdentityKey(row),
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

  return rows.map((row) => {
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
  })
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
    dedupedByIdentity.set(buildIdentityKey(normalized), normalized)
  }

  const items: SyncedLibraryItem[] = []

  for (const [identityKey, file] of dedupedByIdentity.entries()) {
    const maxReadyMinutes = getContiguousReadyMinutes(identityKey, previewLength)
    items.push({
      identityKey,
      name: file.name,
      relativePath: file.relativePath,
      size: file.size,
      lastModified: file.lastModified,
      maxReadyMinutes,
      hasFullPreview: maxReadyMinutes >= previewLength,
      lastGeneratedAt: getLastGeneratedAt(identityKey),
    })
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
