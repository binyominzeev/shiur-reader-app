import { AssemblyAI } from 'assemblyai'

let _client: AssemblyAI | null = null

function getClient(): AssemblyAI {
  if (!_client) {
    _client = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY ?? '' })
  }
  return _client
}

/**
 * Transcribe an audio file using AssemblyAI.
 * Uploads the file and polls until transcription is complete.
 */
export async function transcribeFile(filePath: string): Promise<string> {
  const transcript = await getClient().transcripts.transcribe({ audio: filePath })

  if (transcript.status === 'error') {
    throw new Error(`AssemblyAI transcription failed: ${transcript.error}`)
  }

  return transcript.text ?? ''
}
