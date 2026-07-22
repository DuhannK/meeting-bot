/**
 * Standalone verification for AUDIO_ONLY delivery.
 * Drives the REAL DiskUploader finalize path (which runs convertToAudioOnly)
 * against a synthetic webm recording — no live meeting, no upload needed.
 *
 * Run inside the container:
 *   docker compose exec -T meeting-bot npx ts-node src/test/audioOnlyTest.ts
 */
import DiskUploader from '../middleware/disk-uploader';
import config from '../config';
import { loggerFactory } from '../util/logger';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execFileAsync = promisify(execFile);

async function main() {
  const logger = loggerFactory('audio-only-test', 'system');
  const userId = 'testuser';
  const tempFileId = 'audioonlytest123';

  console.log('config.audioOnly =', config.audioOnly, ', extension =', config.audioOnlyExtension);
  if (!config.audioOnly) {
    console.log('RESULT: SKIP — AUDIO_ONLY not enabled in this container env.');
    process.exit(2);
  }

  const uploader: any = await DiskUploader.initialize(
    'token', 'team1', 'UTC', userId, 'bot1', 'prefix', tempFileId, logger, 'https://meet.example/x'
  );

  // Synthetic webm: real video + audio streams, like a captured recording.
  const src = '/tmp/synthetic.webm';
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libvpx-vp9', '-c:a', 'libopus', src,
  ]);
  const buf = fs.readFileSync(src);
  await uploader.saveDataToTempFile(buf);

  // Real finalize — this is what runs before every upload, and calls convertToAudioOnly().
  const ok = await uploader.finalizeDiskWriting();
  console.log('finalizeDiskWriting ok:', ok);
  console.log('fileExtension after:', uploader.fileExtension);
  console.log('contentType after:', uploader.contentType);
  console.log('recordingDuration after:', uploader.recordingDuration);

  const finalPath = (DiskUploader as any).getFilePath(userId, tempFileId, uploader.fileExtension);
  const exists = fs.existsSync(finalPath);
  console.log('final path:', finalPath, 'exists:', exists);

  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
    '-of', 'default=noprint_wrappers=1', finalPath,
  ]);
  console.log('--- final file streams ---\n' + stdout.trim());

  const hasVideo = stdout.includes('codec_type=video');
  const hasAudio = stdout.includes('codec_type=audio');
  const pass =
    ok === true &&
    uploader.fileExtension === '.m4a' &&
    uploader.contentType === 'audio/mp4' &&
    exists && hasAudio && !hasVideo;

  // cleanup
  try { fs.unlinkSync(finalPath); } catch {}
  try { fs.unlinkSync(src); } catch {}

  console.log(pass ? 'RESULT: PASS ✅' : 'RESULT: FAIL ❌');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
