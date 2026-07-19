import path from 'path'
import fs from 'fs/promises'
import { extractChunk } from './ffmpeg'
import { transcribeFile } from './assembly'
import { formatTranscript } from './openai'

export type ChunkStatus = 'pending' | 'processing' | 'done' | 'error'
export type JobStatus = 'pending' | 'processing' | 'done' | 'error'

export interface Chunk {
  index: number
  status: ChunkStatus
  text?: string
  error?: string
}

export interface Job {
  id: string
  status: JobStatus
  totalChunks: number
  completedChunks: number
  currentChunk: number
  chunks: Chunk[]
  error?: string
}

// In-memory job store for single-user MVP
const jobs = new Map<string, Job>()

export function createJob(jobId: string, totalChunks: number): Job {
  const chunks: Chunk[] = Array.from({ length: totalChunks }, (_, i) => ({
    index: i + 1,
    status: 'pending' as ChunkStatus,
  }))

  const job: Job = {
    id: jobId,
    status: 'pending',
    totalChunks,
    completedChunks: 0,
    currentChunk: 0,
    chunks,
  }

  jobs.set(jobId, job)
  return job
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId)
}

export async function startJobProcessing(
  jobId: string,
  inputPath: string,
  previewMinutes: number,
  tmpDir: string
): Promise<void> {
  const job = jobs.get(jobId)
  if (!job) return

  job.status = 'processing'

  try {
    for (let i = 0; i < job.totalChunks; i++) {
      const chunk = job.chunks[i]
      const startSeconds = i * 60
      const chunkPath = path.join(tmpDir, `chunk_${i + 1}.mp3`)

      chunk.status = 'processing'
      job.currentChunk = i + 1

      try {
        // Step 1: Extract chunk with FFmpeg
        await extractChunk(inputPath, chunkPath, startSeconds, 60)

        // Step 2: Transcribe with AssemblyAI
        const rawText = await transcribeFile(chunkPath)

        // Step 3: Format with OpenAI
        const formattedText = rawText.trim()
          ? await formatTranscript(rawText)
          : ''

        chunk.status = 'done'
        chunk.text = formattedText
        job.completedChunks++
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        chunk.status = 'error'
        chunk.error = message
        // Continue with next chunk even if one fails
      } finally {
        // Clean up the chunk temp file
        await fs.unlink(chunkPath).catch(() => undefined)
      }
    }

    job.status = 'done'
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    job.status = 'error'
    job.error = message
  } finally {
    // Clean up the original input file
    await fs.unlink(inputPath).catch(() => undefined)
    await fs.rmdir(tmpDir).catch(() => undefined)
  }
}
