import { NextRequest, NextResponse } from 'next/server'
import {
  getLibraryItemsWithStatusForFiles,
  upsertAudioFiles,
} from '@/lib/services/previewStore'
import type { AudioFileIdentityInput } from '@/lib/services/previewStore'

export const runtime = 'nodejs'

const VALID_PREVIEW_LENGTHS = [3, 5, 10]

type SyncRequestBody = {
  previewLength: number
  files: AudioFileIdentityInput[]
}

function isValidFileInput(value: unknown): value is AudioFileIdentityInput {
  if (!value || typeof value !== 'object') {
    return false
  }

  const item = value as Record<string, unknown>

  return (
    typeof item.name === 'string' &&
    typeof item.relativePath === 'string' &&
    typeof item.size === 'number' &&
    Number.isFinite(item.size) &&
    typeof item.lastModified === 'number' &&
    Number.isFinite(item.lastModified)
  )
}

export async function POST(request: NextRequest) {
  let body: SyncRequestBody

  try {
    body = (await request.json()) as SyncRequestBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const previewLength = Number(body.previewLength)
  if (!VALID_PREVIEW_LENGTHS.includes(previewLength)) {
    return NextResponse.json(
      { error: `Preview length must be one of: ${VALID_PREVIEW_LENGTHS.join(', ')} minutes` },
      { status: 400 }
    )
  }

  if (!Array.isArray(body.files)) {
    return NextResponse.json({ error: 'files must be an array.' }, { status: 400 })
  }

  const files = body.files.filter(isValidFileInput)

  if (files.length !== body.files.length) {
    return NextResponse.json({ error: 'One or more files are invalid.' }, { status: 400 })
  }

  upsertAudioFiles(files)

  const items = getLibraryItemsWithStatusForFiles(files, previewLength)

  return NextResponse.json({
    items,
    total: items.length,
  })
}
