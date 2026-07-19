import 'react'

declare global {
  type FileSystemPermissionMode = 'read' | 'readwrite'
  type FileSystemPermissionState = 'granted' | 'denied' | 'prompt'

  interface FileSystemPermissionDescriptor {
    mode?: FileSystemPermissionMode
  }

  interface FileSystemHandle {
    kind: 'file' | 'directory'
    name: string
    queryPermission(descriptor?: FileSystemPermissionDescriptor): Promise<FileSystemPermissionState>
    requestPermission(descriptor?: FileSystemPermissionDescriptor): Promise<FileSystemPermissionState>
  }

  interface FileSystemFileHandle extends FileSystemHandle {
    kind: 'file'
    getFile(): Promise<File>
  }

  interface FileSystemDirectoryHandle extends FileSystemHandle {
    kind: 'directory'
    values(): AsyncIterable<FileSystemFileHandle | FileSystemDirectoryHandle>
  }

  interface Window {
    showDirectoryPicker: (options?: {
      id?: string
      mode?: 'read' | 'readwrite'
      startIn?: FileSystemHandle | WellKnownDirectory
    }) => Promise<FileSystemDirectoryHandle>
  }

  type WellKnownDirectory =
    | 'desktop'
    | 'documents'
    | 'downloads'
    | 'music'
    | 'pictures'
    | 'videos'
}

declare module 'react' {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string
    directory?: string
  }
}

export {}
