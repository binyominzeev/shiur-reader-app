'use client'

import Image from 'next/image'
import { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore } from 'react'
import QRCode from 'qrcode'
import AudioSelector from '@/components/AudioSelector'
import PreviewLengthSelector from '@/components/PreviewLengthSelector'
import GenerateButton from '@/components/GenerateButton'
import ProgressIndicator from '@/components/ProgressIndicator'
import TranscriptViewer from '@/components/TranscriptViewer'
import { loadFolderHandle, saveFolderHandle } from '@/lib/client/folderHandleStore'
import { loadOwnerToken, saveOwnerToken } from '@/lib/client/ownerTokenStore'
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

interface LibrarySource {
  sourceType: string
  sourceLabel: string | null
  deviceLabel: string | null
  lastSyncedAt: string
}

interface SyncSourceInput {
  sourceType: string
  sourceLabel?: string | null
  deviceLabel?: string | null
}

const POLL_INTERVAL_MS = 2000

function buildIdentityKey(file: {
  relativePath: string
  size: number
}): string {
  return `${file.relativePath.replace(/\\/g, '/').trim()}::${file.size}`
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').trim()
}

function getPathTail(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath)
  const segments = normalized.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? normalized
}

function getDeviceLabel(): string {
  if (typeof navigator === 'undefined') {
    return 'This device'
  }

  const userAgent = navigator.userAgent

  if (/android/i.test(userAgent)) {
    return 'Android device'
  }

  if (/iphone|ipad|ipod/i.test(userAgent)) {
    return 'iPhone or iPad'
  }

  if (/mobile/i.test(userAgent)) {
    return 'Mobile device'
  }

  return 'Desktop browser'
}

function deriveFileInputSourceLabel(files: ClientAudioFile[]): string | null {
  const firstPath = files[0]?.relativePath ?? ''
  const segments = firstPath.split('/').filter(Boolean)

  if (segments.length >= 2) {
    return segments[0]
  }

  return null
}

function parseLibrarySource(value: unknown): LibrarySource | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const source = value as Record<string, unknown>

  if (typeof source.sourceType !== 'string' || typeof source.lastSyncedAt !== 'string') {
    return null
  }

  return {
    sourceType: source.sourceType,
    sourceLabel: typeof source.sourceLabel === 'string' ? source.sourceLabel : null,
    deviceLabel: typeof source.deviceLabel === 'string' ? source.deviceLabel : null,
    lastSyncedAt: source.lastSyncedAt,
  }
}

function describeLibrarySource(source: LibrarySource | null): string {
  if (!source) {
    return 'server library'
  }

  const label = source.sourceLabel || source.sourceType
  const device = source.deviceLabel ? ` on ${source.deviceLabel}` : ''

  return `${label}${device}`
}

function subscribeDirectoryPickerSupport(): () => void {
  return () => undefined
}

function getDirectoryPickerSupportSnapshot(): boolean {
  return 'showDirectoryPicker' in window
}

function getDirectoryPickerSupportServerSnapshot(): boolean {
  return false
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

async function fetchWithOwnerToken(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const ownerToken = loadOwnerToken()

  if (ownerToken) {
    headers.set('x-shiur-owner-token', ownerToken)
  }

  const response = await fetch(input, {
    ...init,
    headers,
    credentials: 'same-origin',
  })

  const nextOwnerToken = response.headers.get('x-shiur-owner-token')?.trim()
  if (nextOwnerToken) {
    saveOwnerToken(nextOwnerToken)
  }

  return response
}

export default function Home() {
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([])
  const [selectedIdentity, setSelectedIdentity] = useState<string | null>(null)
  const [folderHandle, setFolderHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [librarySource, setLibrarySource] = useState<LibrarySource | null>(null)
  const [folderStatus, setFolderStatus] = useState<string>('')
  const [isSyncingLibrary, setIsSyncingLibrary] = useState(false)
  const [previewLength, setPreviewLength] = useState(5)
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobState, setJobState] = useState<JobState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isStartingPairing, setIsStartingPairing] = useState(false)
  const [isCompletingPairing, setIsCompletingPairing] = useState(false)
  const [pairingQrDataUrl, setPairingQrDataUrl] = useState<string | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  const [pairingExpiresAt, setPairingExpiresAt] = useState<string | null>(null)
  const [pairingMessage, setPairingMessage] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const filesRef = useRef<ClientAudioFile[]>([])
  const localFileCacheRef = useRef<Map<string, File>>(new Map())
  const lastSourceRef = useRef<SyncSourceInput | null>(null)
  const completedPairTokenRef = useRef<string | null>(null)
  const supportsDirectoryPicker = useSyncExternalStore(
    subscribeDirectoryPickerSupport,
    getDirectoryPickerSupportSnapshot,
    getDirectoryPickerSupportServerSnapshot
  )
  const deviceLabel = useMemo(() => getDeviceLabel(), [])

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

  const effectiveFolderStatus = useMemo(() => {
    if (folderStatus) {
      return folderStatus
    }

    if (libraryItems.length > 0 && !folderHandle) {
      return `Showing the shared server library from ${describeLibrarySource(librarySource)}. Reconnect this device's folder to rescan locally.`
    }

    return supportsDirectoryPicker
      ? 'No folder selected yet.'
      : 'Persistent folder restore is unavailable in this browser. Use file input mode.'
  }, [folderHandle, folderStatus, libraryItems.length, librarySource, supportsDirectoryPicker])

  const refreshLabel = supportsDirectoryPicker ? 'Refresh folder' : 'Reload saved list'
  const selectorHelperText = supportsDirectoryPicker
    ? 'Pick one folder once, then use Refresh to re-scan if new MP3 files were added.'
    : 'Firefox-style fallback: the selected file list is saved on the server. Use Reload saved list to restore it, or select files again if the folder contents changed.'

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

  const applyLibraryPayload = useCallback((
    data: Record<string, unknown>,
    localFiles: ClientAudioFile[] = []
  ) => {
    const source = parseLibrarySource(data.source)
    setLibrarySource(source)

    if (localFiles.length > 0) {
      for (const file of localFiles) {
        localFileCacheRef.current.set(buildIdentityKey(file), file.file)
      }
    }

    const localFilesByIdentity = new Map(
      localFiles.map((file) => [buildIdentityKey(file), file.file] as const)
    )

    const localFilesByPathAndSize = new Map(
      localFiles.map((file) => [`${normalizeRelativePath(file.relativePath)}::${file.size}`, file.file] as const)
    )

    const localFilesByTailAndSize = new Map(
      localFiles.map((file) => [`${getPathTail(file.relativePath)}::${file.size}`, file.file] as const)
    )

    const localFilesByNameAndSize = new Map(
      localFiles.map((file) => [`${file.name}::${file.size}`, file.file] as const)
    )

    const nextItems: LibraryItem[] = []

    if (Array.isArray(data.items)) {
      for (const item of data.items) {
        if (!item || typeof item !== 'object') {
          continue
        }

        const typedItem = item as Record<string, unknown>
        if (
          typeof typedItem.identityKey !== 'string' ||
          typeof typedItem.name !== 'string' ||
          typeof typedItem.relativePath !== 'string' ||
          typeof typedItem.size !== 'number' ||
          typeof typedItem.lastModified !== 'number'
        ) {
          continue
        }

        nextItems.push({
          identityKey: typedItem.identityKey,
          name: typedItem.name,
          relativePath: typedItem.relativePath,
          size: typedItem.size,
          lastModified: typedItem.lastModified,
          maxReadyMinutes: Number(typedItem.maxReadyMinutes ?? 0),
          hasFullPreview: Boolean(typedItem.hasFullPreview),
          file:
            localFilesByIdentity.get(typedItem.identityKey) ??
            localFilesByPathAndSize.get(`${normalizeRelativePath(typedItem.relativePath)}::${typedItem.size}`) ??
            localFilesByTailAndSize.get(`${getPathTail(typedItem.relativePath)}::${typedItem.size}`) ??
            localFilesByNameAndSize.get(`${typedItem.name}::${typedItem.size}`) ??
            localFileCacheRef.current.get(typedItem.identityKey) ??
            null,
        })
      }
    }

    setLibraryItems(nextItems)
    setSelectedIdentity((previous) => {
      if (previous && nextItems.some((item) => item.identityKey === previous)) {
        return previous
      }

      return nextItems[0]?.identityKey ?? null
    })

    return {
      count: nextItems.length,
      source,
    }
  }, [])

  const loadLibraryFromServer = useCallback(async (updateStatus: boolean) => {
    const res = await fetchWithOwnerToken(`/api/library?previewLength=${previewLength}`)
    const data = await parseApiJson(res)

    if (!res.ok) {
      throw new Error(
        typeof data.error === 'string'
          ? data.error
          : `Library load failed with status ${res.status}`
      )
    }

    const next = applyLibraryPayload(data)

    if (updateStatus) {
      if (next.count > 0) {
        setFolderStatus(`Loaded ${next.count} MP3 files from ${describeLibrarySource(next.source)}.`)
      } else {
        setFolderStatus('No MP3 files are stored on the server yet.')
      }
    }

    return next.count
  }, [applyLibraryPayload, previewLength])

  const syncLibraryWithServer = useCallback(async (
    files: ClientAudioFile[],
    source?: SyncSourceInput | null
  ) => {
    const res = await fetchWithOwnerToken('/api/library/sync', {
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
        source,
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

    lastSourceRef.current = source ?? null
    return applyLibraryPayload(data, files).count
  }, [applyLibraryPayload, previewLength])

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

        const count = await syncLibraryWithServer(files, {
          sourceType: 'directory-handle',
          sourceLabel: handle.name,
          deviceLabel,
        })
        setFolderStatus(`Loaded ${count} MP3 files from saved folder.`)
      } finally {
        setIsSyncingLibrary(false)
      }
    },
    [deviceLabel, ensureReadPermission, syncLibraryWithServer]
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
            await syncLibraryWithServer(filesRef.current, lastSourceRef.current)
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
    let cancelled = false

    void (async () => {
      try {
        await loadLibraryFromServer(true)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load saved library.')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [loadLibraryFromServer])

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
      if (libraryItems.length === 0) {
        return
      }

      void (async () => {
        try {
          await loadLibraryFromServer(false)
        } catch {
          // Ignore silent refresh failures when only changing preview length.
        }
      })()

      return
    }

    void (async () => {
      try {
        await syncLibraryWithServer(filesRef.current, lastSourceRef.current)
      } catch {
        // Ignore silent refresh failures when only changing preview length.
      }
    })()
  }, [libraryItems.length, loadLibraryFromServer, previewLength, syncLibraryWithServer])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const pairToken = params.get('pairToken')

    if (!pairToken || completedPairTokenRef.current === pairToken) {
      return
    }

    completedPairTokenRef.current = pairToken
    setIsCompletingPairing(true)
    setPairingMessage('Connecting this device to the shared library...')

    void (async () => {
      try {
        const res = await fetch('/api/pair/complete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ pairingToken: pairToken }),
        })

        const data = await parseApiJson(res)

        if (!res.ok) {
          throw new Error(
            typeof data.error === 'string'
              ? data.error
              : `Pairing failed with status ${res.status}`
          )
        }

        setPairingMessage('This device is now linked to the shared library.')
        setFolderStatus('Device paired. Select the local folder on this device to enable local refresh.')
        await loadLibraryFromServer(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to pair this device.')
      } finally {
        const nextUrl = new URL(window.location.href)
        nextUrl.searchParams.delete('pairToken')
        window.history.replaceState({}, '', `${nextUrl.pathname}${nextUrl.search}`)
        setIsCompletingPairing(false)
      }
    })()
  }, [loadLibraryFromServer])

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

      const count = await syncLibraryWithServer(files, {
        sourceType: 'directory-handle',
        sourceLabel: handle.name,
        deviceLabel,
      })
      setFolderStatus(`Selected folder with ${count} MP3 files.`)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      setError(err instanceof Error ? err.message : 'Failed to select folder.')
    } finally {
      setIsSyncingLibrary(false)
    }
  }, [deviceLabel, ensureReadPermission, supportsDirectoryPicker, syncLibraryWithServer])

  const handleFallbackSelect = useCallback(async (fileList: FileList) => {
    setError(null)
    setIsSyncingLibrary(true)

    try {
      const files = listMp3FilesFromFileList(fileList)
      filesRef.current = files

      const count = await syncLibraryWithServer(files, {
        sourceType: 'file-input',
        sourceLabel: deriveFileInputSourceLabel(files),
        deviceLabel,
      })
      setFolderStatus(`Loaded ${count} MP3 files from file input.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load selected files.')
    } finally {
      setIsSyncingLibrary(false)
    }
  }, [deviceLabel, syncLibraryWithServer])

  const handleRefresh = useCallback(async () => {
    if (!supportsDirectoryPicker) {
      if (libraryItems.length > 0) {
        try {
          const count = await loadLibraryFromServer(true)
          setFolderStatus(`Reloaded ${count} MP3 files from the saved server list.`)
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to reload saved library.')
        }
      }

      return
    }

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
        await syncLibraryWithServer(filesRef.current, lastSourceRef.current)
        setFolderStatus(`Refreshed ${filesRef.current.length} MP3 files.`)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to refresh file list.')
      }

      return
    }

    if (libraryItems.length > 0) {
      try {
        const count = await loadLibraryFromServer(true)
        setFolderStatus(`Reloaded ${count} MP3 files from the shared server library.`)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to reload saved library.')
      }
    }
  }, [folderHandle, libraryItems.length, loadLibraryFromServer, refreshFromHandle, supportsDirectoryPicker, syncLibraryWithServer])

  const handleStartPairing = useCallback(async () => {
    setError(null)
    setIsStartingPairing(true)

    try {
      const res = await fetchWithOwnerToken('/api/pair/start', {
        method: 'POST',
      })

      const data = await parseApiJson(res)

      if (!res.ok) {
        throw new Error(
          typeof data.error === 'string'
            ? data.error
            : `Pairing start failed with status ${res.status}`
        )
      }

      const nextPairingUrl = typeof data.pairingUrl === 'string' ? data.pairingUrl : ''
      if (!nextPairingUrl) {
        throw new Error('Pairing endpoint did not return a URL.')
      }

      const qrDataUrl = await QRCode.toDataURL(nextPairingUrl, {
        margin: 1,
        width: 220,
      })

      setPairingUrl(nextPairingUrl)
      setPairingQrDataUrl(qrDataUrl)
      setPairingExpiresAt(typeof data.expiresAt === 'string' ? data.expiresAt : null)
      setPairingMessage('Scan this QR code on your phone to share the same library.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start device pairing.')
    } finally {
      setIsStartingPairing(false)
    }
  }, [])

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
      let fileToUpload = selectedItem.file

      const findLocalFileForSelected = (): File | null => {
        const normalizedSelectedPath = normalizeRelativePath(selectedItem.relativePath)
        const selectedTail = getPathTail(selectedItem.relativePath)

        const byIdentity = filesRef.current.find(
          (file) => buildIdentityKey(file) === selectedItem.identityKey
        )
        if (byIdentity?.file) {
          return byIdentity.file
        }

        const byPathAndSize = filesRef.current.find(
          (file) =>
            normalizeRelativePath(file.relativePath) === normalizedSelectedPath &&
            file.size === selectedItem.size
        )
        if (byPathAndSize?.file) {
          return byPathAndSize.file
        }

        const byTailAndSize = filesRef.current.find(
          (file) => getPathTail(file.relativePath) === selectedTail && file.size === selectedItem.size
        )
        if (byTailAndSize?.file) {
          return byTailAndSize.file
        }

        const byNameAndSize = filesRef.current.find(
          (file) => file.name === selectedItem.name && file.size === selectedItem.size
        )
        if (byNameAndSize?.file) {
          return byNameAndSize.file
        }

        return null
      }

      if (!fileToUpload) {
        fileToUpload = findLocalFileForSelected()
      }

      if (!fileToUpload && folderHandle) {
        try {
          await refreshFromHandle(folderHandle, true)
          fileToUpload = findLocalFileForSelected()
        } catch {
          // The final message below gives the actionable next step.
        }
      }

      if (!fileToUpload) {
        setIsGenerating(false)
        setError('File content is unavailable. Please refresh the folder first.')
        return
      }

      formData.append('file', fileToUpload)
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
  }, [folderHandle, pollJob, previewLength, refreshFromHandle, selectedItem, stopPolling])

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
          refreshLabel={refreshLabel}
          helperText={selectorHelperText}
        />

        <p className="text-xs text-gray-500">{effectiveFolderStatus}</p>

        <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-sky-900">Pair another device</p>
              <p className="text-xs text-sky-700">
                Share the same server-side library with your phone via QR. Local folder access still has to be granted separately on each device.
              </p>
            </div>

            <button
              type="button"
              onClick={handleStartPairing}
              disabled={isProcessing || isSyncingLibrary || isStartingPairing || isCompletingPairing}
              className="px-4 py-2 rounded-lg bg-sky-600 text-white text-sm font-medium hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isStartingPairing ? 'Preparing QR...' : 'Show pairing QR'}
            </button>
          </div>

          {pairingMessage && (
            <p className="text-xs text-sky-800">{pairingMessage}</p>
          )}

          {pairingQrDataUrl && pairingUrl && (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Image
                src={pairingQrDataUrl}
                alt="QR code for pairing this library with another device"
                width={176}
                height={176}
                className="h-44 w-44 rounded-lg border border-sky-200 bg-white p-2"
              />

              <div className="min-w-0 flex-1 text-xs text-sky-900">
                <p className="font-medium">Open on phone</p>
                <p className="mt-1 break-all">{pairingUrl}</p>
                {pairingExpiresAt && (
                  <p className="mt-2 text-sky-700">
                    Expires at {new Date(pairingExpiresAt).toLocaleString()}.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

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
                  className={`w-full text-left px-3 py-2 flex items-start justify-between gap-3 transition-colors ${
                    selected ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <span className="text-sm text-gray-800 whitespace-normal break-all min-w-0 flex-1">
                    {item.relativePath}
                  </span>
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
