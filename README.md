# Shiur Reader App

Shiur Reader is a Next.js web app that turns the first few minutes of a long audio recording into readable text, so users can quickly understand the beginning of a shiur without listening end-to-end.

The app currently supports MP3 input, splits the selected preview window into 1-minute chunks, transcribes each chunk with AssemblyAI, and then lightly formats the transcript with OpenAI for readability.

## Purpose

- Save time when triaging long recordings.
- Provide a readable preview of the opening section (3, 5, or 10 minutes).
- Keep processing transparent with chunk-level progress and per-chunk results.

## Core Features

- Upload audio from the browser.
- Select preview length: 3, 5, or 10 minutes.
- Background server job with polling-based progress updates.
- Chunk-by-chunk transcript rendering with status indicators.
- Basic PWA installability (manifest + service worker registration).

## Tech Stack

- Framework: Next.js 16 (App Router)
- UI: React 19 + Tailwind CSS 4
- Language: TypeScript
- Speech-to-text: AssemblyAI SDK
- Transcript cleanup/formatting: OpenAI SDK
- Audio chunk extraction: FFmpeg CLI (invoked from Node)
- Job IDs: uuid

## How It Works

1. User uploads an audio file and picks a preview length.
2. Browser sends multipart form data to POST /api/transcribe.
3. Server saves the upload to a temporary directory and creates an in-memory job.
4. A background task processes each 60-second chunk:
	 - Extract chunk with FFmpeg
	 - Transcribe chunk with AssemblyAI
	 - Format transcript text with OpenAI
5. Browser polls GET /api/transcribe/:jobId every 2 seconds.
6. UI shows progress and chunk outputs as they complete.

```mermaid
flowchart LR
	U[User Uploads MP3] --> FE[Next.js Client]
	FE -->|POST /api/transcribe| API1[Transcribe Route]
	API1 --> TMP[Write temp input file]
	TMP --> JOB[In-memory Job Store]
	JOB --> BG[Background Processor]
	BG --> FFMPEG[FFmpeg chunk extraction]
	FFMPEG --> AAI[AssemblyAI transcription]
	AAI --> OAI[OpenAI formatting]
	OAI --> JOB
	FE -->|poll GET /api/transcribe/:jobId| API2[Job Status Route]
	API2 --> FE
```

## API Endpoints

### POST /api/transcribe

Starts a new transcription preview job.

Request:

- Content-Type: multipart/form-data
- Fields:
	- file: audio file (currently stored as input.mp3 on server temp path)
	- previewLength: one of 3, 5, 10 (minutes)

Success response:

```json
{
	"jobId": "uuid-string"
}
```

Error response example:

```json
{
	"error": "Preview length must be one of: 3, 5, 10 minutes"
}
```

### GET /api/transcribe/:jobId

Returns job status and chunk results.

Response shape:

```json
{
	"status": "pending | processing | done | error",
	"completedChunks": 2,
	"totalChunks": 5,
	"currentChunk": 3,
	"chunks": [
		{
			"index": 1,
			"status": "done",
			"text": "..."
		},
		{
			"index": 2,
			"status": "error",
			"error": "..."
		}
	],
	"error": "optional job-level error"
}
```

## Project Structure

```text
app/
	api/transcribe/route.ts            # POST endpoint: create + start job
	api/transcribe/[jobId]/route.ts    # GET endpoint: poll job state
	page.tsx                           # Main client UI and polling logic
components/
	AudioSelector.tsx
	PreviewLengthSelector.tsx
	GenerateButton.tsx
	ProgressIndicator.tsx
	TranscriptViewer.tsx
	ServiceWorkerRegistration.tsx
lib/services/
	transcriptionJob.ts                # Job state model + background loop
	ffmpeg.ts                          # FFmpeg wrapper
	assembly.ts                        # AssemblyAI integration
	openai.ts                          # OpenAI transcript formatting
public/
	manifest.json
	sw.js
```

## Prerequisites

- Node.js 20+
- npm
- FFmpeg available on PATH
- AssemblyAI API key
- OpenAI API key

Install FFmpeg on Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y ffmpeg
```

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create local environment file:

```bash
cp .env.local.example .env.local
```

3. Set environment variables in .env.local:

```env
ASSEMBLYAI_API_KEY=your_assemblyai_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
```

## Run

Development:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm run start
```

Lint:

```bash
npm run lint
```

## Usage

1. Open the app in the browser.
2. Upload an MP3 file.
3. Select preview length (3/5/10 minutes).
4. Click Generate Preview.
5. Watch progress as chunks are processed.
6. Read completed chunk transcripts as they appear.

## Environment Variables

- ASSEMBLYAI_API_KEY: required, used in lib/services/assembly.ts
- OPENAI_API_KEY: required, used in lib/services/openai.ts

## Operational Notes

- Jobs are stored in memory only.
- If the server restarts, all active/completed jobs are lost.
- Temporary files are created under OS temp dir and removed after processing.
- Chunk failures do not stop the whole job; processing continues for later chunks.
- A job can still finish with status done even if some chunks have status error.

## Current Limitations

- Single-instance MVP design (no persistent queue or shared datastore).
- No user authentication or rate limiting.
- No true offline behavior despite service worker presence.
- Assumes FFmpeg is installed and callable as ffmpeg.
- Default OpenAI model is currently hardcoded (gpt-4o-mini).

## Troubleshooting

- Error: ffmpeg not found
	- Install FFmpeg and ensure it is in PATH.
- Error: No audio file provided
	- Ensure form field name is file.
- Error: Preview length must be one of 3, 5, 10
	- Send a valid previewLength.
- Error from AssemblyAI/OpenAI
	- Check API keys and account quotas.

## Security and Privacy Considerations

- Uploaded audio is processed server-side and sent to third-party APIs (AssemblyAI and OpenAI).
- Do not upload sensitive audio unless your policy allows external processing.
- Consider adding consent messaging and retention policy documentation before production usage.

## Future Improvements

- Persistent job storage (Redis/DB) and resumable job tracking.
- Queue/worker architecture for scaling.
- Support more audio formats and configurable chunk length.
- Better retry behavior for per-chunk failures.
- Optional raw transcript view alongside formatted output.
