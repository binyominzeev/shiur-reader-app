'use client'

interface AudioSelectorProps {
  onFileChange: (file: File | null) => void
  disabled: boolean
}

export default function AudioSelector({ onFileChange, disabled }: AudioSelectorProps) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-gray-700" htmlFor="audio-file">
        Audio file
      </label>
      <input
        id="audio-file"
        type="file"
        accept=".mp3,audio/*"
        disabled={disabled}
        className="block w-full text-sm text-gray-600 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
      />
    </div>
  )
}
