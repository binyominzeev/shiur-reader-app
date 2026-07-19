'use client'

const PREVIEW_OPTIONS = [
  { label: '3 minutes', value: 3 },
  { label: '5 minutes', value: 5 },
  { label: '10 minutes', value: 10 },
]

interface PreviewLengthSelectorProps {
  value: number
  onChange: (value: number) => void
  disabled: boolean
}

export default function PreviewLengthSelector({
  value,
  onChange,
  disabled,
}: PreviewLengthSelectorProps) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-gray-700">Preview length</label>
      <div className="flex gap-3">
        {PREVIEW_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              value === option.value
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
