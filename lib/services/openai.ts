import OpenAI from 'openai'

let _client: OpenAI | null = null

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return _client
}

const SYSTEM_PROMPT = `You are editing an automatic speech recognition transcript.

Improve punctuation.

Split into paragraphs.

Correct obvious recognition mistakes.

Do not summarize.

Do not add information.

Do not remove information.

Preserve wording whenever possible.`

/**
 * Format a raw ASR transcript using OpenAI GPT.
 */
export async function formatTranscript(text: string): Promise<string> {
  const response = await getClient().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
  })

  return response.choices[0]?.message?.content ?? text
}
