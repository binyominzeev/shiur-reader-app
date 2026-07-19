import { NextRequest, NextResponse } from 'next/server'
import { v4 as uuidv4 } from 'uuid'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { createJob, startJobProcessing, getJob } from '@/lib/services/transcriptionJob'

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
  const previewLengthRaw = formData.get('previewLength')
  const previewLength = previewLengthRaw
    ? parseInt(String(previewLengthRaw), 10)
    : DEFAULT_PREVIEW_LENGTH

  if (!file) {
    return NextResponse.json({ error: 'No audio file provided' }, { status: 400 })
  }

  if (!VALID_PREVIEW_LENGTHS.includes(previewLength)) {
    return NextResponse.json(
      { error: `Preview length must be one of: ${VALID_PREVIEW_LENGTHS.join(', ')} minutes` },
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

    const totalChunks = previewLength // 1 chunk per minute
    createJob(jobId, totalChunks)

    // Start background processing — intentionally not awaited
    startJobProcessing(jobId, inputPath, previewLength, tmpDir).catch((err) => {
      console.error(`Job ${jobId} failed:`, err)
      // Ensure polling clients can observe the failure even if the job manager
      // did not catch the error itself
      const job = getJob(jobId)
      if (job && job.status !== 'done' && job.status !== 'error') {
        job.status = 'error'
        job.error = err instanceof Error ? err.message : 'Unexpected server error'
      }
    })

    return NextResponse.json({ jobId })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected server error'
    return NextResponse.json({ error: `Upload failed: ${message}` }, { status: 500 })
  }
}
