import { NextRequest, NextResponse } from 'next/server'
import { attachOwnerTokenCookie } from '@/lib/server/ownerSession'
import { consumePairingSession } from '@/lib/services/previewStore'

export const runtime = 'nodejs'

type CompletePairingRequest = {
  pairingToken?: unknown
}

export async function POST(request: NextRequest) {
  let body: CompletePairingRequest

  try {
    body = (await request.json()) as CompletePairingRequest
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const pairingToken = typeof body.pairingToken === 'string'
    ? body.pairingToken.trim()
    : ''

  if (!pairingToken) {
    return NextResponse.json({ error: 'pairingToken is required.' }, { status: 400 })
  }

  const result = consumePairingSession(pairingToken)

  if (result.status === 'invalid') {
    return NextResponse.json({ error: 'Pairing token is invalid.' }, { status: 404 })
  }

  if (result.status === 'expired') {
    return NextResponse.json({ error: 'Pairing token expired.' }, { status: 410 })
  }

  if (result.status === 'used') {
    return NextResponse.json({ error: 'Pairing token was already used.' }, { status: 409 })
  }

  if (result.status !== 'paired') {
    return NextResponse.json({ error: 'Pairing failed.' }, { status: 400 })
  }

  const response = NextResponse.json({ paired: true })
  attachOwnerTokenCookie(response, result.ownerToken)
  return response
}