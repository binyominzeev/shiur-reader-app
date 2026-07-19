import { NextRequest, NextResponse } from 'next/server'
import { getJob } from '@/lib/services/transcriptionJob'

export const runtime = 'nodejs'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params
  const job = getJob(jobId)

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  return NextResponse.json({
    status: job.status,
    completedChunks: job.completedChunks,
    totalChunks: job.totalChunks,
    currentChunk: job.currentChunk,
    chunks: job.chunks,
    isCacheHit: job.isCacheHit,
    reusedChunks: job.reusedChunks,
    newChunks: job.newChunks,
    source: job.source,
    error: job.error,
  })
}
