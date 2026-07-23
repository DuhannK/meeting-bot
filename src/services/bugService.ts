import config, { NODE_ENV } from '../config';
import { Storage } from '@google-cloud/storage';
import { Logger } from 'winston';
import { promises as fs } from 'fs';
import path from 'path';

interface UploadOption {
  skipTimestamp?: boolean;
}

const storage = new Storage();

async function uploadImageToGCP(
  fileName: string,
  buffer: Buffer,
  logger: Logger
): Promise<void> {
  try {
    const bucket = storage.bucket(config.miscStorageBucket ?? '');
    const file = bucket.file(fileName);
    await file.save(buffer);
  } catch (error) {
    logger.error('Error uploading buffer:', error);
  }
}

// TODO Save to local volume for development
export const uploadDebugImage = async (
  buffer: Buffer,
  fileName: string,
  userId: string,
  logger: Logger,
  botId?: string,
  opts?: UploadOption
) => {
  try {
    if (NODE_ENV === 'development') {
      // Save to the bind-mounted screenshots dir so failures can be inspected
      // from the host. Avoid ':' in the filename — the mount is NTFS-backed.
      const dir = path.join(process.cwd(), 'assets', 'screenshots');
      await fs.mkdir(dir, { recursive: true });
      const stamp = opts?.skipTimestamp ? '' : `-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const localFile = path.join(dir, `${fileName}${stamp}.png`);
      await fs.writeFile(localFile, buffer);
      logger.info(`Debug image saved locally: ${localFile}`, userId);
      return;
    }
    logger.info('Begin upload Debug Image', userId);
    if (!config.miscStorageBucket) {
      logger.error('Developer TODO: Add .env value for GCP_MISC_BUCKET', userId);
      return;
    }
    const bot = botId ?? 'bot';
    const now = opts?.skipTimestamp ? '' : `-${new Date().toISOString()}`;
    const qualifiedFile = `${config.miscStorageFolder}/${userId}/${bot}/${fileName}${now}.png`;
    await uploadImageToGCP(qualifiedFile, buffer, logger);
    logger.info(`Debug Image File uploaded successfully: ${fileName}`, userId);
  } catch (err) {
    logger.error('Error uploading debug image:', userId, err);
  }
};
