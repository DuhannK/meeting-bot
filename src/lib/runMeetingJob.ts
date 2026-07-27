import { Logger } from 'winston';
import { MeetingJoinRedisParams } from '../app/common';
import DiskUploader, { IUploader } from '../middleware/disk-uploader';
import { getRecordingNamePrefix } from '../util/recordingName';
import { encodeFileNameSafebase64 } from '../util/strings';
import { JoinParams } from '../bots/AbstractMeetBot';
import { GoogleMeetBot } from '../bots/GoogleMeetBot';
import { MicrosoftTeamsBot } from '../bots/MicrosoftTeamsBot';
import { ZoomBot } from '../bots/ZoomBot';

/**
 * Tek bir toplantıyı uçtan uca işler: disk uploader'ı kurar, sağlayıcıya göre
 * doğru botu çalıştırır (katıl → kaydet → yükle). Kayıt-hazır / hata event'leri
 * bot ve uploader tarafından zaten Redis'e basılır.
 *
 * Bu mantık iki giriş noktasından paylaşılır ve TEK yerde tutulur:
 *   1. RedisConsumerService  → uzun ömürlü kuyruk tüketicisi (klasik mod)
 *   2. runOnce (src/runOnce.ts) → toplantı başına ephemeral worker konteyneri
 *      (RUN_ONCE modu; backend Docker ile başlatır, iş bitince konteyner çıkar)
 *
 * Davranış her iki çağrıda birebir aynıdır — önceden RedisConsumerService
 * içinde satır içi olan blok buraya taşındı.
 */
export async function runMeetingJob(
  meetingParams: MeetingJoinRedisParams,
  logger: Logger,
  correlationId: string,
): Promise<void> {
  // Initialize disk uploader
  const entityId = meetingParams.botId ?? meetingParams.eventId;
  const tempId = `${meetingParams.userId}${entityId}0`; // Using 0 as retry count
  const tempFileId = encodeFileNameSafebase64(tempId);
  const namePrefix = getRecordingNamePrefix(meetingParams.provider);

  const uploader: IUploader = await DiskUploader.initialize(
    meetingParams.bearerToken,
    meetingParams.teamId,
    meetingParams.timezone,
    meetingParams.userId,
    meetingParams.botId ?? '',
    namePrefix,
    tempFileId,
    logger,
    meetingParams.url,
  );

  // Create and join the meeting
  const joinParams: JoinParams = {
    url: meetingParams.url,
    name: meetingParams.name,
    bearerToken: meetingParams.bearerToken,
    teamId: meetingParams.teamId,
    timezone: meetingParams.timezone,
    userId: meetingParams.userId,
    eventId: meetingParams.eventId,
    botId: meetingParams.botId,
    uploader,
  };

  switch (meetingParams.provider) {
    case 'google': {
      const googleBot = new GoogleMeetBot(logger, correlationId);
      await googleBot.join(joinParams);
      logger.info('Google Meet recording job completed successfully (join, record, upload).', meetingParams.userId, meetingParams.teamId);
      break;
    }
    case 'microsoft': {
      const microsoftBot = new MicrosoftTeamsBot(logger, correlationId);
      await microsoftBot.join(joinParams);
      logger.info('Microsoft Teams recording job completed successfully (join, record, upload).', meetingParams.userId, meetingParams.teamId);
      break;
    }
    case 'zoom': {
      const zoomBot = new ZoomBot(logger, correlationId);
      await zoomBot.join(joinParams);
      logger.info('Zoom recording job completed successfully (join, record, upload).', meetingParams.userId, meetingParams.teamId);
      break;
    }
    default:
      throw new Error(`Unsupported provider: ${meetingParams.provider}`);
  }
}
