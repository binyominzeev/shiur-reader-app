import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * Extract a time-bounded chunk from an audio file using FFmpeg.
 * Uses execFile to avoid shell injection via file path interpolation.
 */
export async function extractChunk(
  inputPath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number = 60
): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-i', inputPath,
    '-ss', String(startSeconds),
    '-t', String(durationSeconds),
    '-y',
    outputPath,
  ])
}
