'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import AudioSelector from '@/components/AudioSelector'
import PreviewLengthSelector from '@/components/PreviewLengthSelector'
import GenerateButton from '@/components/GenerateButton'
import ProgressIndicator from '@/components/ProgressIndicator'
import TranscriptViewer from '@/components/TranscriptViewer'
import { loadFolderHandle, saveFolderHandle } from '@/lib/client/folderHandleStore'
import {
  type ClientAudioFile,
  listMp3FilesFromFileList,
  listMp3FilesFromHandle,
} from '@/lib/client/folderScan'
import type { Chunk, JobStatus } from '@/lib/services/transcriptionJob'

interface JobState {
  status: JobStatus
  completedChunks: number
  totalChunks: number
  currentChunk: number
  chunks: Chunk[]
  isCacheHit?: boolean
  reusedChunks?: number
  newChunks?: number
  source?: 'cache' | 'generated'
  error?: string
}

interface LibraryItem {
  identityKey: string
  name: string
  relativePath: string
  size: number
  lastModified: number
  maxReadyMinutes: number
  hasFullPreview: boolean
  file: File | null
}

const POLL_INTERVAL_MS = 2000

function buildIdentityKey(file: {
  relativePath: string
  size: number
}): string {
  return `${file.relativePath.replace(/\\/g, '/').trim()}::${file.size}`
}

function buildStatusLookupKey(file: {
  relativePath: string
  size: number
}): string {
  return `${file.relativePath.replace(/\\/g, '/').trim()}::${file.size}`
}

async function parseApiJson(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text()

  if (!raw) {
    return {}
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    const preview = raw.slice(0, 140).replace(/\s+/g, ' ').trim()
    throw new Error(
      `Non-JSON response from ${response.url} (status ${response.status}): ${preview || 'empty body'}`
    )
  }
}

export default function Home() {
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([])
  const [selectedIdentity, setSelectedIdentity] = useState<string | null>(null)
  const [folderHandle, setFolderHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [folderStatus, setFolderStatus] = useState<string>('')
  const [isSyncingLibrary, setIsSyncingLibrary] = useState(false)
  const [previewLength, setPreviewLength] = useState(5)
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobState, setJobState] = useState<JobState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const filesRef = useRef<ClientAudioFile[]>([])

  const supportsDirectoryPicker = useMemo(
    () => typeof window !== 'undefined' && 'showDirectoryPicker' in window,
    []
  )

  const selectedItem = selectedIdentity
    ? libraryItems.find((item) => item.identityKey === selectedIdentity) ?? null
    : null

  const missingMinutes = selectedItem
    ? Math.max(0, previewLength - selectedItem.maxReadyMinutes)
    : 0

  const generateLabel = selectedItem
    ? selectedItem.hasFullPreview
      ? 'Load Saved Preview'
      : selectedItem.maxReadyMinutes > 0
        ? `Generate Missing ${missingMinutes} min`
        : 'Generate Preview'
    : 'Generate Preview'

  const effectiveFolderStatus = folderStatus || (
    supportsDirectoryPicker
      ? 'No folder selected yet.'
      : 'Persistent folder restore is unavailable in this browser. Use file input mode.'
  )

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const ensureReadPermission = useCallback(
    async (handle: FileSystemDirectoryHandle, requestPermission: boolean): Promise<boolean> => {
      const options = { mode: 'read' } as const

      const queryState = await handle.queryPermission(options)
      if (queryState === 'granted') {
        return true
      }

      if (!requestPermission) {
        return false
      }

      const requestState = await handle.requestPermission(options)
      return requestState === 'granted'
    },
    []
  )

  const syncLibraryWithServer = useCallback(async (files: ClientAudioFile[]) => {
    const res = await fetch('/api/library/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        previewLength,
        files: files.map((file) => ({
          name: file.name,
          relativePath: file.relativePath,
          size: file.size,
          lastModified: file.lastModified,
        })),
      }),
    })

    const data = await parseApiJson(res)

    if (!res.ok) {
      throw new Error(
        typeof data.error === 'string'
          ? data.error
          : `Library sync failed with status ${res.status}`
      )
    }

    const statusMap = new Map<string, {
      maxReadyMinutes: number
      hasFullPreview: boolean
    }>()

    if (Array.isArray(data.items)) {
      for (const item of data.items) {
        if (!item || typeof item !== 'object' || typeof item.identityKey !== 'string') {
          continue
        }

        const typedItem = item as {
          relativePath?: unknown
          size?: unknown
          maxReadyMinutes?: unknown
          hasFullPreview?: unknown
        }

        if (typeof typedItem.relativePath !== 'string' || typeof typedItem.size !== 'number') {
          continue
        }

        statusMap.set(buildStatusLookupKey({
          relativePath: typedItem.relativePath,
          size: typedItem.size,
        }), {
          maxReadyMinutes: Number(item.maxReadyMinutes ?? 0),
          hasFullPreview: Boolean(item.hasFullPreview),
        })
      }
    }

    const mergedItems: LibraryItem[] = files.map((file) => {
      const identityKey = buildIdentityKey(file)
      const status = statusMap.get(buildStatusLookupKey(file))
      return {
        identityKey,
        name: file.name,
        relativePath: file.relativePath,
        size: file.size,
        lastModified: file.lastModified,
        maxReadyMinutes: status?.maxReadyMinutes ?? 0,
        hasFullPreview: status?.hasFullPreview ?? false,
        file: file.file,
      }
    })

    setLibraryItems(mergedItems)
    setSelectedIdentity((previous) => {
      if (previous && mergedItems.some((item) => item.identityKey === previous)) {
        return previous
      }
      return mergedItems[0]?.identityKey ?? null
    })

    return mergedItems.length
  }, [previewLength])

  const refreshFromHandle = useCallback(
    async (handle: FileSystemDirectoryHandle, requestPermission: boolean) => {
      setError(null)
      setIsSyncingLibrary(true)

      try {
        const hasPermission = await ensureReadPermission(handle, requestPermission)
        if (!hasPermission) {
          setFolderStatus('Saved folder found, but read permission is not granted.')
          return
        }

        const files = await listMp3FilesFromHandle(handle)
        filesRef.current = files

        const count = await syncLibraryWithServer(files)
        setFolderStatus(`Loaded ${count} MP3 files from saved folder.`)
      } finally {
        setIsSyncingLibrary(false)
      }
    },
    [ensureReadPermission, syncLibraryWithServer]
  )

  const pollJob = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/transcribe/${id}`)
      const data = await parseApiJson(res)

      if (!res.ok) {
        throw new Error(
          typeof data.error === 'string'
            ? data.error
            : `Server error ${res.status}`
        )
      }

      const nextState = data as unknown as JobState
      setJobState(nextState)

      if (nextState.status === 'done' || nextState.status === 'error') {
        stopPolling()
        setIsGenerating(false)

        if (filesRef.current.length > 0) {
          try {
            await syncLibraryWithServer(filesRef.current)
          } catch {
            // Ignore status refresh errors after completed jobs.
          }
        }

        if (nextState.status === 'error') {
          setError(nextState.error ?? 'An unexpected error occurred.')
        }
      }
    } catch (err) {
      stopPolling()
      setIsGenerating(false)
      setError(err instanceof Error ? err.message : 'Failed to fetch job status.')
    }
  }, [stopPolling, syncLibraryWithServer])

  useEffect(() => {
    if (!jobId) return
    pollRef.current = setInterval(() => pollJob(jobId), POLL_INTERVAL_MS)
    return () => stopPolling()
  }, [jobId, pollJob, stopPolling])

  useEffect(() => {
    if (!supportsDirectoryPicker) {
      return
    }

    let cancelled = false

    async function restoreFolder() {
      try {
        const handle = await loadFolderHandle()
        if (!handle || cancelled) {
          return
        }

        setFolderHandle(handle)
        await refreshFromHandle(handle, false)
      } catch {
        if (!cancelled) {
          setFolderStatus('Could not restore saved folder. Please select it again.')
        }
      }
    }

    void restoreFolder()

    return () => {
      cancelled = true
    }
  }, [refreshFromHandle, supportsDirectoryPicker])

  useEffect(() => {
    if (filesRef.current.length === 0) {
      return
    }

    void (async () => {
      try {
        await syncLibraryWithServer(filesRef.current)
      } catch {
        // Ignore silent refresh failures when only changing preview length.
      }
    })()
  }, [previewLength, syncLibraryWithServer])

  const handlePickDirectory = useCallback(async () => {
    if (!supportsDirectoryPicker) {
      return
    }

    setError(null)
    setIsSyncingLibrary(true)

    try {
      const handle = await window.showDirectoryPicker({ id: 'shiur-reader-mp3-folder' })
      const hasPermission = await ensureReadPermission(handle, true)
      if (!hasPermission) {
        setFolderStatus('Folder permission was denied.')
        return
      }

      await saveFolderHandle(handle)
      setFolderHandle(handle)

      const files = await listMp3FilesFromHandle(handle)
      filesRef.current = files

      const count = await syncLibraryWithServer(files)
      setFolderStatus(`Selected folder with ${count} MP3 files.`)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      setError(err instanceof Error ? err.message : 'Failed to select folder.')
    } finally {
      setIsSyncingLibrary(false)
    }
  }, [ensureReadPermission, supportsDirectoryPicker, syncLibraryWithServer])

  const handleFallbackSelect = useCallback(async (fileList: FileList) => {
    setError(null)
    setIsSyncingLibrary(true)

    try {
      const files = listMp3FilesFromFileList(fileList)
      filesRef.current = files

      const count = await syncLibraryWithServer(files)
      setFolderStatus(`Loaded ${count} MP3 files from file input.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load selected files.')
    } finally {
      setIsSyncingLibrary(false)
    }
  }, [syncLibraryWithServer])

  const handleRefresh = useCallback(async () => {
    if (folderHandle) {
      try {
        await refreshFromHandle(folderHandle, true)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to refresh folder.')
      }
      return
    }

    if (filesRef.current.length > 0) {
      try {
        await syncLibraryWithServer(filesRef.current)
        setFolderStatus(`Refreshed ${filesRef.current.length} MP3 files.`)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to refresh file list.')
      }
    }
  }, [folderHandle, refreshFromHandle, syncLibraryWithServer])

  const handleGenerate = useCallback(async () => {
    if (!selectedItem) {
      return
    }

    setError(null)
    setJobState(null)
    setJobId(null)
    setIsGenerating(true)
    stopPolling()

    const formData = new FormData()
    formData.append('previewLength', String(previewLength))
    formData.append('name', selectedItem.name)
    formData.append('relativePath', selectedItem.relativePath)
    formData.append('size', String(selectedItem.size))
    formData.append('lastModified', String(selectedItem.lastModified))

    if (!selectedItem.hasFullPreview) {
      if (!selectedItem.file) {
        setIsGenerating(false)
        setError('File content is unavailable. Please refresh the folder first.')
        return
      }
      formData.append('file', selectedItem.file)
    }

    try {
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
      })

      const data = await parseApiJson(res)

      if (!res.ok) {
        throw new Error(
          typeof data.error === 'string'
            ? data.error
            : `Upload failed with status ${res.status}`
        )
      }

      const nextJobId = typeof data.jobId === 'string' ? data.jobId : null
      if (!nextJobId) {
        throw new Error('Transcribe endpoint did not return a valid jobId.')
      }

      setJobId(nextJobId)
      void pollJob(nextJobId)
    } catch (err) {
      setIsGenerating(false)
      setError(err instanceof Error ? err.message : 'Failed to start transcription.')
    }
  }, [pollJob, previewLength, selectedItem, stopPolling])

  const isProcessing = isGenerating
  const showProgress =
    jobState !== null &&
    (jobState.status === 'processing' || jobState.status === 'pending')
  const showTranscript = jobState !== null && jobState.chunks.length > 0

  return (
    <main className="min-h-screen flex flex-col items-center px-4 py-10">
      {/* Header */}
      <header className="w-full max-w-2xl mb-8">
        <h1 className="text-3xl font-bold text-blue-600">Shiur Reader</h1>
        <p className="mt-1 text-gray-500 text-sm">
          Read the beginning of a long recording — no listening required.
        </p>
      </header>

      {/* Controls */}
      <section className="w-full max-w-2xl bg-white rounded-2xl shadow-md p-6 flex flex-col gap-5">
        <AudioSelector
          onPickDirectory={handlePickDirectory}
          onFallbackSelect={handleFallbackSelect}
          onRefresh={handleRefresh}
          hasSavedFolder={folderHandle !== null || libraryItems.length > 0}
          supportsDirectoryPicker={supportsDirectoryPicker}
          isSyncing={isSyncingLibrary}
          disabled={isProcessing}
        />

        <p className="text-xs text-gray-500">{effectiveFolderStatus}</p>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-gray-700">MP3 files</p>
          <div className="max-h-56 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
            {libraryItems.length === 0 && (
              <p className="text-sm text-gray-500 p-3">No MP3 files loaded yet.</p>
            )}

            {libraryItems.map((item) => {
              const selected = item.identityKey === selectedIdentity
              const statusText = item.hasFullPreview
                ? `${previewLength}m ready`
                : item.maxReadyMinutes > 0
                  ? `${item.maxReadyMinutes}m ready`
                  : 'No preview'

              return (
                <button
                  key={item.identityKey}
                  type="button"
                  onClick={() => setSelectedIdentity(item.identityKey)}
                  className={`w-full text-left px-3 py-2 flex items-center justify-between gap-3 transition-colors ${
                    selected ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <span className="text-sm text-gray-800 truncate">{item.relativePath}</span>
                  <span
                    className={`text-xs px-2 py-1 rounded-full whitespace-nowrap ${
                      item.hasFullPreview
                        ? 'bg-green-100 text-green-700'
                        : item.maxReadyMinutes > 0
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {statusText}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <PreviewLengthSelector
          value={previewLength}
          onChange={setPreviewLength}
          disabled={isProcessing || isSyncingLibrary}
        />
        <GenerateButton
          onClick={handleGenerate}
          disabled={isProcessing || !selectedItem || isSyncingLibrary}
          isGenerating={isGenerating}
          label={generateLabel}
        />
      </section>

      {/* Error message */}
      {error && (
        <div className="w-full max-w-2xl mt-4 p-4 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm">
          {error}
        </div>
      )}

      {/* Progress */}
      {showProgress && jobState && (
        <section className="w-full max-w-2xl mt-6">
          <ProgressIndicator
            currentChunk={jobState.currentChunk}
            totalChunks={jobState.totalChunks}
          />
        </section>
      )}

      {/* Transcript */}
      {showTranscript && jobState && (
        <section className="w-full max-w-2xl mt-6">
          <TranscriptViewer chunks={jobState.chunks} totalChunks={jobState.totalChunks} />
        </section>
      )}
    </main>
  )
}
