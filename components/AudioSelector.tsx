'use client'

import { useRef, type InputHTMLAttributes } from 'react'

interface AudioSelectorProps {
  onPickDirectory: () => void
  onFallbackSelect: (files: FileList) => void
  onRefresh: () => void
  hasSavedFolder: boolean
  supportsDirectoryPicker: boolean
  isSyncing: boolean
  disabled: boolean
}

export default function AudioSelector({
  onPickDirectory,
  onFallbackSelect,
  onRefresh,
  hasSavedFolder,
  supportsDirectoryPicker,
  isSyncing,
  disabled,
}: AudioSelectorProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  const directoryInputProps = {
    webkitdirectory: '',
    directory: '',
  } as InputHTMLAttributes<HTMLInputElement>

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-gray-700" htmlFor="audio-file">
        MP3 folder
      </label>

      <div className="flex flex-wrap gap-2">
        {supportsDirectoryPicker && (
          <button
            type="button"
            onClick={onPickDirectory}
            disabled={disabled || isSyncing}
            className="px-4 py-2 rounded-lg bg-blue-50 text-blue-700 text-sm font-medium hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Select folder
          </button>
        )}

        <button
          type="button"
          onClick={onRefresh}
          disabled={disabled || isSyncing || !hasSavedFolder}
          className="px-4 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Refresh folder
        </button>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || isSyncing}
          className="px-4 py-2 rounded-lg bg-white border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Select via file input
        </button>
      </div>

      <input
        {...directoryInputProps}
        ref={inputRef}
        id="audio-file"
        type="file"
        multiple
        accept=".mp3,audio/mpeg"
        className="hidden"
        onChange={(e) => {
          if (e.target.files) {
            onFallbackSelect(e.target.files)
          }
          e.target.value = ''
        }}
      />

      <p className="text-xs text-gray-500">
        Pick one folder once, then use Refresh to re-scan if new MP3 files were added.
      </p>
    </div>
  )
}
