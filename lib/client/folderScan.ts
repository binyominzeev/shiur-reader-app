export interface ClientAudioFile {
  file: File
  name: string
  relativePath: string
  size: number
  lastModified: number
}

function isMp3File(name: string): boolean {
  return name.toLowerCase().endsWith('.mp3')
}

async function walkDirectory(
  handle: FileSystemDirectoryHandle,
  basePath: string,
  out: ClientAudioFile[]
): Promise<void> {
  for await (const entry of handle.values()) {
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name

    if (entry.kind === 'directory') {
      continue
    }

    if (!isMp3File(entry.name)) {
      continue
    }

    const file = await entry.getFile()
    out.push({
      file,
      name: file.name,
      relativePath: entryPath,
      size: file.size,
      lastModified: file.lastModified,
    })
  }
}

export async function listMp3FilesFromHandle(
  handle: FileSystemDirectoryHandle
): Promise<ClientAudioFile[]> {
  const files: ClientAudioFile[] = []
  await walkDirectory(handle, '', files)
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return files
}

export function listMp3FilesFromFileList(fileList: FileList): ClientAudioFile[] {
  const files = Array.from(fileList)
    .map((file) => {
      const webkitRelativePath =
        (file as File & { webkitRelativePath?: string }).webkitRelativePath || ''

      return {
        file,
        webkitRelativePath,
      }
    })
    .filter((item) => isMp3File(item.file.name))
    .filter((item, _, allItems) => {
      if (!item.webkitRelativePath) {
        return true
      }

      const rootFolder = allItems
        .find((candidate) => candidate.webkitRelativePath)
        ?.webkitRelativePath
        .split('/')
        .filter(Boolean)[0]

      if (!rootFolder) {
        return true
      }

      const segments = item.webkitRelativePath.split('/').filter(Boolean)

      // Keep only files directly under the selected folder: RootFolder/file.mp3
      return segments.length === 2 && segments[0] === rootFolder
    })
    .map((item) => {
      const segments = item.webkitRelativePath.split('/').filter(Boolean)
      const relativePath =
        segments.length >= 2
          ? segments[segments.length - 1]
          : item.file.name

      return {
        file: item.file,
        name: item.file.name,
        relativePath,
        size: item.file.size,
        lastModified: item.file.lastModified,
      }
    })

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return files
}
