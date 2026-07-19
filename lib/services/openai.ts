import OpenAI from 'openai'
import { GoogleGenAI, ThinkingLevel } from '@google/genai'

type TranscriptProvider = 'gemini' | 'openai'

let _openAIClient: OpenAI | null = null
let _geminiClient: GoogleGenAI | null = null

// Flip this switch to true when you need request debug logs locally.
const ENABLE_TRANSCRIPT_AI_DEBUG = false
const TRANSCRIPT_AI_DEBUG_ENV = process.env.TRANSCRIPT_AI_DEBUG === 'true'

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite'

function getTranscriptProvider(): TranscriptProvider {
  const rawProvider = (process.env.TRANSCRIPT_AI_PROVIDER ?? 'gemini').toLowerCase()
  return rawProvider === 'openai' ? 'openai' : 'gemini'
}

function getOpenAIClient(): OpenAI {
  if (!_openAIClient) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('Missing OPENAI_API_KEY for OpenAI transcript formatting provider')
    }
    _openAIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return _openAIClient
}

function getGeminiClient(): GoogleGenAI {
  if (!_geminiClient) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('Missing GEMINI_API_KEY for Gemini transcript formatting provider')
    }

    _geminiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    })
  }

  return _geminiClient
}

const SYSTEM_PROMPT = `You are editing an automatic speech recognition transcript.

Improve punctuation.

Split into paragraphs.

Correct obvious recognition mistakes.

Do not summarize.

Do not add information.

Do not remove information.

Preserve wording whenever possible.`

function shouldLogOpenAIDebug(): boolean {
  return (ENABLE_TRANSCRIPT_AI_DEBUG || TRANSCRIPT_AI_DEBUG_ENV) && process.env.NODE_ENV !== 'production'
}

function normalizeGeminiModel(model: string): string {
  // Accept common typo: gemini-3.1.-flash-lite -> gemini-3.1-flash-lite
  return model.replace('.-', '-')
}

function logOpenAITranscriptDebug(request: {
  provider: TranscriptProvider
  model: string
  messages: ReadonlyArray<{ role: 'system' | 'user'; content: string }>
}) {
  if (!shouldLogOpenAIDebug()) {
    return
  }

  console.debug('[openai:transcript] chat.completions.create request', {
    provider: request.provider,
    model: request.model,
    parameters: {
      messagesCount: request.messages.length,
    },
    prompt: request.messages,
  })
}

function logOpenAITranscriptError(error: unknown, context: {
  provider: TranscriptProvider
  model: string
}) {
  if (!shouldLogOpenAIDebug()) {
    return
  }

  if (error instanceof OpenAI.APIError) {
    console.debug('[openai:transcript] request failed', {
      provider: context.provider,
      model: context.model,
      status: error.status,
      code: error.code,
      type: error.type,
      param: error.param,
      message: error.message,
      body: error.error,
      headers: error.headers,
    })
    return
  }

  console.debug('[openai:transcript] unexpected error', {
    provider: context.provider,
    model: context.model,
    error,
  })
}

function getGeminiDebugErrorDetails(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) {
    return { error }
  }

  const maybeError = error as {
    message?: unknown
    status?: unknown
    code?: unknown
    details?: unknown
    stack?: unknown
  }

  return {
    message: maybeError.message,
    status: maybeError.status,
    code: maybeError.code,
    details: maybeError.details,
    stack: maybeError.stack,
  }
}

/**
 * Format a raw ASR transcript using OpenAI GPT.
 */
export async function formatTranscript(text: string): Promise<string> {
  const provider = getTranscriptProvider()
  const model = provider === 'openai'
    ? OPENAI_MODEL
    : normalizeGeminiModel(GEMINI_MODEL)
  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: text },
  ]

  logOpenAITranscriptDebug({ provider, model, messages })

  if (provider === 'openai') {
    const client = getOpenAIClient()

    let response
    try {
      response = await client.chat.completions.create({
        model,
        messages,
      })
    } catch (error) {
      logOpenAITranscriptError(error, { provider, model })
      throw error
    }

    const content = response.choices[0]?.message?.content
    if (!content) {
      throw new Error('Transcript formatter returned an empty response')
    }
    return content
  }

  const geminiClient = getGeminiClient()

  try {
    const stream = await geminiClient.models.generateContentStream({
      model,
      config: {
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
        },
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `${SYSTEM_PROMPT}\n\nTranscript:\n${text}`,
            },
          ],
        },
      ],
    })

    let content = ''
    for await (const chunk of stream) {
      if (chunk.text) {
        content += chunk.text
      }
    }

    if (!content.trim()) {
      throw new Error('Gemini returned an empty response')
    }

    return content
  } catch (error) {
    if (shouldLogOpenAIDebug()) {
      console.debug('[gemini:transcript] request failed', {
        provider,
        model,
        error: getGeminiDebugErrorDetails(error),
      })
    }
    throw error
  }
}
