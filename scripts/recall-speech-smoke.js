// Explicit, potentially billable live check. Never invoked by package scripts or ordinary tests.
// Securely set GNANI_API_KEY, then run:
// node scripts/recall-speech-smoke.js --live --user-recorded --clip <local-PCM-WAV-path>
// Uploads ONLY that user-recorded <=25 s clip and a fixed non-meeting TTS phrase to Gnani.
// Prints status/format metadata only. No key, transcript, path, audio or provider error bodies.
const fs = require('node:fs');
const { transcribe, synthesize, GnaniSpeechError, LIMITS } = require('../electron/providers/speech/gnani');

async function main() {
  const args = process.argv.slice(2);
  const clipIndex = args.indexOf('--clip');
  const clipPath = clipIndex < 0 ? null : args[clipIndex + 1];
  const missing = [];
  if (!args.includes('--live')) missing.push('EXPLICIT_LIVE_FLAG');
  if (!args.includes('--user-recorded')) missing.push('USER_RECORDED_CLIP_CONFIRMATION');
  if (!process.env.GNANI_API_KEY?.trim()) missing.push('GNANI_API_KEY');
  if (!clipPath || clipPath.startsWith('--')) missing.push('CLIP_PATH');
  if (missing.length) {
    console.log(JSON.stringify({ live: 'NOT_RUN', missing, playback: 'NOT_TESTED' }));
    process.exitCode = 2;
    return;
  }

  let audio;
  try {
    const stat = fs.statSync(clipPath);
    if (!stat.isFile() || !stat.size || stat.size > LIMITS.uploadBytes) throw new Error();
    audio = fs.readFileSync(clipPath);
  } catch {
    console.log(JSON.stringify({ live: 'NOT_RUN', reason: 'CLIP_UNAVAILABLE_OR_OVERSIZED', playback: 'NOT_TESTED' }));
    process.exitCode = 2;
    return;
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  const options = { apiKey: process.env.GNANI_API_KEY, signal: controller.signal };
  const result = { live: 'ATTEMPTED', playback: 'NOT_TESTED' };
  const failure = err => ({ status: 'FAILED', code: err instanceof GnaniSpeechError ? err.code : 'LOCAL_ERROR',
    ...(err instanceof GnaniSpeechError && err.status !== undefined ? { httpStatus: err.status } : {}) });
  try {
    try {
      const stt = await transcribe({ ...options, audio });
      result.stt = { status: 'PASSED', nonEmptyTranscript: !!stt.text };
    } catch (err) {
      result.stt = failure(err);
      if (['AUTH_REQUIRED', 'INVALID_AUDIO', 'AUDIO_TOO_LARGE', 'AUDIO_TOO_LONG', 'INVALID_REQUEST', 'CANCELLED'].includes(result.stt.code)) {
        result.tts = { status: 'NOT_RUN', reason: 'LOCAL_PREFLIGHT_OR_CANCELLATION' };
        return;
      }
    }
    if (controller.signal.aborted) {
      result.tts = { status: 'NOT_RUN', reason: 'CANCELLED' };
      return;
    }
    try {
      const tts = await synthesize({ ...options, text: 'This is a MeetScribe speech transport check.', language: 'en-IN' });
      result.tts = { status: 'PASSED', bytes: tts.audio.length, mimeType: tts.mimeType,
        sampleRate: tts.sampleRate, durationSeconds: tts.durationSeconds };
    } catch (err) { result.tts = failure(err); }
  } finally {
    process.removeListener('SIGINT', stop);
    console.log(JSON.stringify(result));
    if (result.stt?.status !== 'PASSED' || result.tts?.status !== 'PASSED') process.exitCode = 1;
  }
}

main().catch(() => {
  console.log(JSON.stringify({ live: 'FAILED', code: 'LOCAL_ERROR', playback: 'NOT_TESTED' }));
  process.exitCode = 1;
});
