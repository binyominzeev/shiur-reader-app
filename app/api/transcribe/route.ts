import { NextRequest, NextResponse } from 'next/server'
import { v4 as uuidv4 } from 'uuid'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import type { Chunk } from '@/lib/services/transcriptionJob'
import { createJob, startJobProcessing, getJob } from '@/lib/services/transcriptionJob'
import {
  buildIdentityKey,
  getChunksForPreview,
  getReusePlan,
  saveMinuteChunk,
  upsertAudioFiles,
} from '@/lib/services/previewStore'

export const runtime = 'nodejs'

const VALID_PREVIEW_LENGTHS = [3, 5, 10]
const DEFAULT_PREVIEW_LENGTH = 5

export async function POST(request: NextRequest) {
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Failed to parse form data' }, { status: 400 })
  }

  const file = formData.get('file') as File | null
  const nameRaw = formData.get('name')
  const relativePathRaw = formData.get('relativePath')
  const sizeRaw = formData.get('size')
  const lastModifiedRaw = formData.get('lastModified')
  const previewLengthRaw = formData.get('previewLength')
  const previewLength = previewLengthRaw
    ? parseInt(String(previewLengthRaw), 10)
    : DEFAULT_PREVIEW_LENGTH

  const name = String(nameRaw ?? file?.name ?? '').trim()
  const relativePath = String(relativePathRaw ?? '').trim()
  const size = Number(sizeRaw ?? file?.size ?? 0)
  const lastModified = Number(lastModifiedRaw ?? file?.lastModified ?? 0)

  if (!VALID_PREVIEW_LENGTHS.includes(previewLength)) {
    return NextResponse.json(
      { error: `Preview length must be one of: ${VALID_PREVIEW_LENGTHS.join(', ')} minutes` },
      { status: 400 }
    )
  }

  if (!name || !relativePath || !Number.isFinite(size) || !Number.isFinite(lastModified)) {
    return NextResponse.json(
      { error: 'Missing or invalid file identity metadata.' },
      { status: 400 }
    )
  }

  const identity = {
    name,
    relativePath,
    size,
    lastModified,
  }

  upsertAudioFiles([identity])

  const identityKey = buildIdentityKey(identity)
  const reusePlan = getReusePlan(identityKey, previewLength)

  if (reusePlan.readyMinutes >= previewLength) {
    const storedChunks = getChunksForPreview(identityKey, previewLength)
    const chunkMap = new Map(storedChunks.map((row) => [row.minuteIndex, row]))
    const chunks: Chunk[] = Array.from({ length: previewLength }, (_, i) => {
      const minuteIndex = i + 1
      const stored = chunkMap.get(minuteIndex)

      return {
        index: minuteIndex,
        status: stored?.status ?? 'done',
        text: stored?.text ?? '',
        error: stored?.error ?? undefined,
      }
    })

    const jobId = uuidv4()
    createJob(jobId, previewLength, {
      initialChunks: chunks,
      status: 'done',
      isCacheHit: true,
      reusedChunks: previewLength,
      newChunks: 0,
      source: 'cache',
    })

    return NextResponse.json({
      jobId,
      cacheHit: true,
      reusedChunks: previewLength,
      newChunks: 0,
    })
  }

  if (!file) {
    return NextResponse.json(
      {
        error: 'Missing audio file for generating additional preview minutes.',
      },
      { status: 400 }
    )
  }

  const jobId = uuidv4()
  const tmpDir = path.join(os.tmpdir(), 'shiur-jobs', jobId)

  try {
    await fs.mkdir(tmpDir, { recursive: true })

    const buffer = Buffer.from(await file.arrayBuffer())
    const inputPath = path.join(tmpDir, 'input.mp3')
    await fs.writeFile(inputPath, buffer)

    const chunks: Chunk[] = Array.from({ length: previewLength }, (_, i) => {
      const minuteIndex = i + 1
      const reused = reusePlan.reusedChunks.find((chunk) => chunk.minuteIndex === minuteIndex)

      if (reused) {
        return {
          index: minuteIndex,
          status: 'done',
          text: reused.text ?? '',
        }
      }

      return {
        index: minuteIndex,
        status: 'pending',
      }
    })

    createJob(jobId, previewLength, {
      initialChunks: chunks,
      isCacheHit: false,
      reusedChunks: reusePlan.readyMinutes,
      newChunks: previewLength - reusePlan.readyMinutes,
      source: 'generated',
    })

    // Start background processing — intentionally not awaited
    startJobProcessing(jobId, inputPath, tmpDir, {
      startMinute: reusePlan.readyMinutes + 1,
      onChunkFinalized: async (minuteIndex, chunk) => {
        if (chunk.status === 'done') {
          saveMinuteChunk(identityKey, minuteIndex, 'done', chunk.text)
        }

        if (chunk.status === 'error') {
          saveMinuteChunk(identityKey, minuteIndex, 'error', undefined, chunk.error)
        }
      },
    }).catch((err) => {
      console.error(`Job ${jobId} failed:`, err)
      // Ensure polling clients can observe the failure even if the job manager
      // did not catch the error itself
      const job = getJob(jobId)
      if (job && job.status !== 'done' && job.status !== 'error') {
        job.status = 'error'
        job.error = err instanceof Error ? err.message : 'Unexpected server error'
      }
    })

    return NextResponse.json({
      jobId,
      cacheHit: false,
      reusedChunks: reusePlan.readyMinutes,
      newChunks: previewLength - reusePlan.readyMinutes,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected server error'
    return NextResponse.json({ error: `Upload failed: ${message}` }, { status: 500 })
  }
}
