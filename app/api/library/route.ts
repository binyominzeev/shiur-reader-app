import { NextRequest, NextResponse } from 'next/server'
import { getOrCreateOwnerToken, attachOwnerTokenCookie } from '@/lib/server/ownerSession'
import {
  getOwnerLibraryItemsWithStatus,
  getOwnerLibrarySource,
} from '@/lib/services/previewStore'

export const runtime = 'nodejs'

const VALID_PREVIEW_LENGTHS = [3, 5, 10]
const DEFAULT_PREVIEW_LENGTH = 5

export async function GET(request: NextRequest) {
  const previewLengthRaw = request.nextUrl.searchParams.get('previewLength')
  const previewLength = previewLengthRaw
    ? Number(previewLengthRaw)
    : DEFAULT_PREVIEW_LENGTH

  if (!VALID_PREVIEW_LENGTHS.includes(previewLength)) {
    return NextResponse.json(
      { error: `Preview length must be one of: ${VALID_PREVIEW_LENGTHS.join(', ')} minutes` },
      { status: 400 }
    )
  }

  const { ownerToken, created } = getOrCreateOwnerToken(request)
  const response = NextResponse.json({
    items: getOwnerLibraryItemsWithStatus(ownerToken, previewLength),
    source: getOwnerLibrarySource(ownerToken),
  })

  attachOwnerTokenCookie(response, ownerToken)

  return response
}