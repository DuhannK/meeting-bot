/**
 * End-to-end delivery verification: drives the REAL uploader all the way through
 * upload + notification, against a synthetic recording — no live meeting.
 *   - audio-only extraction (convertToAudioOnly)
 *   - upload to the configured object storage (local MinIO)
 *   - "recording completed" Redis notification
 *
 * Run inside the container:
 *   docker compose exec -T meeting-bot npx ts-node src/test/deliveryTest.ts
 */
import DiskUploader from '../middleware/disk-uploader';
import config from '../config';
import { loggerFactory } from '../util/logger';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execFileAsync = promisify(execFile);

async function main() {
  const logger = loggerFactory('delivery-test', 'system');
  const userId = 'deliverytest';
  const tempFileId = 'delivery' + Date.now();

  console.log('audioOnly:', config.audioOnly, '| uploaderType:', config.uploaderType,
    '| storageProvider:', config.storageProvider, '| notifyRedisEnabled:', config.notifyRedisEnabled);
  console.log('S3 endpoint:', config.s3CompatibleStorage.endpoint, '| bucket:', config.s3CompatibleStorage.bucket);

  const uploader: any = await DiskUploader.initialize(
    'token', 'team1', 'UTC', userId, 'botDelivery', 'MeetRec', tempFileId, logger, 'https://meet.example/delivery'
  );

  const src = '/tmp/delivery.webm';
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libvpx-vp9', '-c:a', 'libopus', src,
  ]);
  await uploader.saveDataToTempFile(fs.readFileSync(src));

  // saveDataToTempFile writes asynchronously; wait for it to hit disk before upload.
  // (In the real bot this file is written over minutes of the meeting.)
  const tempPath = (DiskUploader as any).getFilePath(userId, tempFileId, '.webm');
  for (let i = 0; i < 50 && !fs.existsSync(tempPath); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log('temp written:', fs.existsSync(tempPath), tempPath);

  // Real path: finalize -> convertToAudioOnly -> upload to MinIO -> notify Redis.
  const ok = await uploader.uploadRecordingToRemoteStorage();
  console.log('uploadRecordingToRemoteStorage:', ok);
  console.log('final fileExtension:', uploader.fileExtension, '| contentType:', uploader.contentType);
  console.log('blobUrl:', uploader.lastUploadedBlobUrl);

  try { fs.unlinkSync(src); } catch {}

  const pass = ok === true && uploader.fileExtension === '.m4a' && uploader.contentType === 'audio/mp4';
  console.log(pass ? 'RESULT: PASS ✅' : 'RESULT: FAIL ❌');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
