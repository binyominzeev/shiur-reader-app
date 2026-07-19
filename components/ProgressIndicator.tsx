'use client'

interface ProgressIndicatorProps {
  currentChunk: number
  totalChunks: number
}

export default function ProgressIndicator({ currentChunk, totalChunks }: ProgressIndicatorProps) {
  const progress = totalChunks > 0 ? Math.round((currentChunk / totalChunks) * 100) : 0

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-gray-600">
        Processing chunk {currentChunk} of {totalChunks}…
      </p>
      <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 rounded-full transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
}
