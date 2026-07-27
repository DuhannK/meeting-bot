// Ensure global Web Crypto API is available (needed by Azure SDK, polyfill for older Node versions)
import './shims/crypto-polyfill';
import { MeetingJoinRedisParams, MeetingProvider, notifyMeetingJoinFailure } from './app/common';
import { runMeetingJob } from './lib/runMeetingJob';
import { createCorrelationId, loggerFactory } from './util/logger';

/**
 * RUN_ONCE modu — toplantı başına EPHEMERAL worker giriş noktası.
 *
 * Uzun ömürlü Express sunucusu / Redis kuyruğu tüketicisi başlatmaz; env'den
 * TEK toplantıyı okuyup çalıştırır ve iş bitince süreç (dolayısıyla konteyner)
 * çıkar. Ana proje (beetinq) her çakışan toplantı için Docker ile bir worker
 * konteyneri açar; bu sayede eş zamanlı kayıt, konteyner izolasyonuyla (her
 * worker kendi ekranı/ses sink'i) sağlanır — bkz. start-worker.sh.
 *
 * MIP eşleştirme sözleşmesi korunur: botId = userId = MEETING_ID. Bot bu
 * değerleri kayıt-hazır payload'ının metadata'sında geri döndürür; ingest
 * kaydı bu alandan toplantıya bağlar.
 *
 * Çıkış kodları: 0 = başarı, 1 = iş hatası (failure event de basılır),
 * 2 = eksik/geçersiz env (konfig hatası).
 */

const VALID_PROVIDERS: MeetingProvider[] = ['google', 'microsoft', 'zoom'];

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(`RUN_ONCE: missing required env ${name}`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const meetingId = requiredEnv('MEETING_ID');
  const url = requiredEnv('MEETING_URL');

  const providerRaw = (process.env.MEETING_PROVIDER || process.env.PROVIDER || '').trim() as MeetingProvider;
  if (!VALID_PROVIDERS.includes(providerRaw)) {
    console.error(`RUN_ONCE: invalid MEETING_PROVIDER "${providerRaw}" (expected one of ${VALID_PROVIDERS.join(', ')})`);
    process.exit(2);
  }
  const provider = providerRaw;

  const name = process.env.BOT_NAME || 'Meeting Bot';

  // botId = userId = meetingId → MIP eşleştirme sözleşmesi (meeting-bot.service.ts)
  const params: MeetingJoinRedisParams = {
    provider,
    url,
    name,
    botId: meetingId,
    userId: meetingId,
    eventId: undefined,
    teamId: process.env.TEAM_ID || 'mip',
    timezone: process.env.MEETING_TIMEZONE || 'Europe/Istanbul',
    bearerToken: process.env.BEARER_TOKEN || 'mip-internal',
  };

  const correlationId = createCorrelationId({
    teamId: params.teamId,
    userId: params.userId,
    botId: params.botId,
    eventId: params.eventId,
    url: params.url,
  });
  const logger = loggerFactory(correlationId, provider);

  logger.info('RUN_ONCE worker starting single meeting job', {
    provider,
    meetingId,
    url,
    name,
  });

  try {
    await runMeetingJob(params, logger, correlationId);
    logger.info('RUN_ONCE worker finished successfully — exiting', { meetingId, provider });
    // Flush stdout/stderr, then exit cleanly so the ephemeral container is reaped (--rm).
    process.exit(0);
  } catch (error) {
    logger.error('RUN_ONCE worker failed', { error, meetingId, provider });
    // Emit the failure event so the backend ingest marks the meeting 'failed'
    // (only if it is still 'joining') — mirrors RedisConsumerService's onPermanentFailure.
    try {
      await notifyMeetingJoinFailure(params, error, logger);
    } catch (notifyError) {
      logger.warn('RUN_ONCE: failed to emit meeting failure notification', notifyError as any);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('RUN_ONCE fatal error', error);
  process.exit(1);
});
