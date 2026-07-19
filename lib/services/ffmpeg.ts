import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

/**
 * Extract a time-bounded chunk from an audio file using FFmpeg.
 */
export async function extractChunk(
  inputPath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number = 60
): Promise<void> {
  const cmd = `ffmpeg -i "${inputPath}" -ss ${startSeconds} -t ${durationSeconds} -y "${outputPath}" 2>&1`
  await execAsync(cmd)
}
