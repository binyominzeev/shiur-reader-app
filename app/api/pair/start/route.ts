import { randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { attachOwnerTokenCookie, getOrCreateOwnerToken } from '@/lib/server/ownerSession'
import { createPairingSession } from '@/lib/services/previewStore'

export const runtime = 'nodejs'

const PAIRING_TTL_MS = 10 * 60 * 1000
const PAIRING_ORIGIN = 'https://reader.myshiurim.com'

export async function POST(request: NextRequest) {
  const { ownerToken, created } = getOrCreateOwnerToken(request)
  const pairingToken = randomBytes(24).toString('base64url')
  const session = createPairingSession(ownerToken, pairingToken, PAIRING_TTL_MS)
  const pairingUrl = new URL('/', PAIRING_ORIGIN)

  pairingUrl.searchParams.set('pairToken', session.pairingToken)

  const response = NextResponse.json({
    pairingToken: session.pairingToken,
    pairingUrl: pairingUrl.toString(),
    expiresAt: session.expiresAt,
  })

  attachOwnerTokenCookie(response, ownerToken)

  return response
}