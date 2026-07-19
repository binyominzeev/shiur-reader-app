const DB_NAME = 'shiur-reader-client'
const STORE_NAME = 'handles'
const KEY = 'selected-mp3-folder'

async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb()

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(handle, KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })

  db.close()
}

export async function loadFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb()

  const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).get(KEY)
    request.onsuccess = () => {
      resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null)
    }
    request.onerror = () => reject(request.error)
  })

  db.close()
  return handle
}

export async function clearFolderHandle(): Promise<void> {
  const db = await openDb()

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })

  db.close()
}
