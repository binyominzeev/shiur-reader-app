import { randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'

export const OWNER_COOKIE_NAME = 'shiur_reader_owner'
export const OWNER_HEADER_NAME = 'x-shiur-owner-token'

function generateOwnerToken(): string {
  return randomBytes(32).toString('base64url')
}

export function getOrCreateOwnerToken(request: NextRequest): {
  ownerToken: string
  created: boolean
} {
  const fromHeader = request.headers.get(OWNER_HEADER_NAME)?.trim()
  if (fromHeader) {
    return {
      ownerToken: fromHeader,
      created: false,
    }
  }

  const existing = request.cookies.get(OWNER_COOKIE_NAME)?.value?.trim()

  if (existing) {
    return {
      ownerToken: existing,
      created: false,
    }
  }

  return {
    ownerToken: generateOwnerToken(),
    created: true,
  }
}

export function attachOwnerTokenCookie(response: NextResponse, ownerToken: string): void {
  response.cookies.set({
    name: OWNER_COOKIE_NAME,
    value: ownerToken,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365 * 5,
  })

  response.headers.set(OWNER_HEADER_NAME, ownerToken)
}