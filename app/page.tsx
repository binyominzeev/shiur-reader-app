'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import AudioSelector from '@/components/AudioSelector'
import PreviewLengthSelector from '@/components/PreviewLengthSelector'
import GenerateButton from '@/components/GenerateButton'
import ProgressIndicator from '@/components/ProgressIndicator'
import TranscriptViewer from '@/components/TranscriptViewer'
import type { Chunk, JobStatus } from '@/lib/services/transcriptionJob'

interface JobState {
  status: JobStatus
  completedChunks: number
  totalChunks: number
  currentChunk: number
  chunks: Chunk[]
  error?: string
}

const POLL_INTERVAL_MS = 2000

export default function Home() {
  const [file, setFile] = useState<File | null>(null)
  const [previewLength, setPreviewLength] = useState(5)
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobState, setJobState] = useState<JobState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const pollJob = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/transcribe/${id}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `Server error ${res.status}`)
      }
      const data: JobState = await res.json()
      setJobState(data)

      if (data.status === 'done' || data.status === 'error') {
        stopPolling()
        setIsGenerating(false)
        if (data.status === 'error') {
          setError(data.error ?? 'An unexpected error occurred.')
        }
      }
    } catch (err) {
      stopPolling()
      setIsGenerating(false)
      setError(err instanceof Error ? err.message : 'Failed to fetch job status.')
    }
  }, [stopPolling])

  useEffect(() => {
    if (!jobId) return
    pollRef.current = setInterval(() => pollJob(jobId), POLL_INTERVAL_MS)
    return () => stopPolling()
  }, [jobId, pollJob, stopPolling])

  const handleGenerate = useCallback(async () => {
    if (!file) return

    setError(null)
    setJobState(null)
    setJobId(null)
    setIsGenerating(true)
    stopPolling()

    const formData = new FormData()
    formData.append('file', file)
    formData.append('previewLength', String(previewLength))

    try {
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error ?? `Upload failed with status ${res.status}`)
      }

      setJobId(data.jobId)
    } catch (err) {
      setIsGenerating(false)
      setError(err instanceof Error ? err.message : 'Failed to start transcription.')
    }
  }, [file, previewLength, stopPolling])

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
        <AudioSelector onFileChange={setFile} disabled={isProcessing} />
        <PreviewLengthSelector
          value={previewLength}
          onChange={setPreviewLength}
          disabled={isProcessing}
        />
        <GenerateButton
          onClick={handleGenerate}
          disabled={isProcessing || !file}
          isGenerating={isGenerating}
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
