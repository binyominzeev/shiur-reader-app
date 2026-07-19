'use client'

import { useEffect, useRef } from 'react'
import type { Chunk } from '@/lib/services/transcriptionJob'

interface TranscriptViewerProps {
  chunks: Chunk[]
  totalChunks: number
}

export default function TranscriptViewer({ chunks, totalChunks }: TranscriptViewerProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to newest completed chunk
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chunks])

  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: totalChunks }, (_, i) => {
        const chunk = chunks[i]
        const index = i + 1

        if (!chunk || chunk.status === 'pending') {
          return null
        }

        return (
          <div key={index} className="border border-gray-200 rounded-lg p-4 bg-white shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              {chunk.status === 'done' && (
                <span className="text-green-500" title="Done">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                </span>
              )}
              {chunk.status === 'processing' && (
                <svg
                  className="animate-spin h-5 w-5 text-blue-500"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
              )}
              {chunk.status === 'error' && (
                <span className="text-red-500" title="Error">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                      clipRule="evenodd"
                    />
                  </svg>
                </span>
              )}
              <span className="text-sm font-semibold text-gray-700">Chunk {index}</span>
            </div>

            {chunk.status === 'processing' && (
              <p className="text-gray-400 italic text-sm">Loading…</p>
            )}

            {chunk.status === 'done' && chunk.text && (
              <div className="text-gray-800 text-sm leading-relaxed whitespace-pre-wrap">
                {chunk.text}
              </div>
            )}

            {chunk.status === 'done' && !chunk.text && (
              <p className="text-gray-400 italic text-sm">No speech detected in this segment.</p>
            )}

            {chunk.status === 'error' && (
              <p className="text-red-500 text-sm">{chunk.error ?? 'An error occurred.'}</p>
            )}
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
