# meeting-bot → Ana Proje Entegrasyon Devri

meeting-bot tarafı hazır. Bu doküman, ana projede (NestJS + ai-service + web)
yapılması gerekenleri ve meeting-bot'un sunduğu entegrasyon sözleşmesini içerir.

---

## ✅ meeting-bot tarafında TAMAMLANANLAR

1. **Audio-only çıktı**: Bot, toplantı kaydını upload öncesi `.m4a`'ya (AAC 128k,
   audio-only) dönüştürür. (`AUDIO_ONLY=true`, istenirse `AUDIO_ONLY_EXTENSION=.wav`)
2. **MinIO'ya yükleme**: Kayıt, S3-uyumlu MinIO bucket'ına yüklenir.
3. **Redis "kayıt hazır" bildirimi**: Upload bitince Redis listesine event basılır.
4. Uçtan uca doğrulandı (sentetik kayıtla; MinIO'da nesne + Redis'te payload teyit edildi).

---

## 📄 ENTEGRASYON SÖZLEŞMESİ (ana projenin tüketeceği)

### Redis event
- **Bağlantı**: `redis://<redis-host>:6379`, **DB 1**
- **Başarı listesi**: `jobs:meetbot:recordings` (bot RPUSH yapar → consumer BLPOP/BLMOVE ile tüketmeli)
- **Hata listesi**: `jobs:meetbot:failures` (katılma/kayıt kalıcı başarısız olursa)

### Başarı payload örneği (gerçek test çıktısı)
```json
{
  "recordingId": "delivery1784639231268",
  "meetingLink": "https://meet.example/delivery",
  "status": "completed",
  "blobUrl": "http://minio:9000/meeting-recordings/meeting-bot/<userId>/<ad>.m4a",
  "timestamp": "2026-07-21T13:07:13.029Z",
  "metadata": {
    "userId": "...", "teamId": "...", "botId": "...",
    "contentType": "audio/mp4",
    "uploaderType": "s3",
    "duration": 3,
    "storage": {
      "provider": "s3",
      "bucket": "meeting-recordings",
      "key": "meeting-bot/<userId>/<ad>.m4a",
      "region": "us-east-1",
      "endpoint": "http://minio:9000",
      "forcePathStyle": true,
      "url": "http://minio:9000/meeting-recordings/..."
    }
  }
}
```

### MinIO (S3-uyumlu) erişimi
- **Endpoint**: `http://minio:9000` (compose-içi ad) — host'tan `http://localhost:9000`
- **Konsol UI**: `http://localhost:9001`
- **Kimlik**: `minioadmin` / `minioadmin` (yerel geliştirme; üretimde değiştirilecek)
- **Bucket**: `meeting-recordings`, **path-style** erişim (`forcePathStyle=true`)
- **Nesne düzeni**: `meeting-bot/{userId}/{isim}.m4a` — audio-only AAC, `audio/mp4`

### Ağ notu
Ana proje konteynerlerinin aynı MinIO + Redis'e erişmesi gerekir. Seçenekler:
- **a)** İki compose'u aynı external Docker network'e bağla (önerilen), veya
- **b)** Host üzerinden: MinIO `localhost:9000`, Redis `localhost:6379` yayınlı durumda.

---

## 📋 ANA PROJEDE YAPILACAKLAR

### 1) Meeting-bot ingest consumer'ı (yeni, küçük modül)
- Redis DB 1, `jobs:meetbot:recordings` listesini dinle (BLPOP veya güvenli teslim
  için BLMOVE → işleme listesi → bitince LREM).
- Payload'daki `storage.key` ile MinIO'dan `.m4a`'yı indir
  (S3 client: endpoint `http://minio:9000`, path-style, minioadmin).
- İndirilen dosyayı **drag-drop yüklemesiyle aynı** upload/analiz servisine ver
  → mevcut WhisperX pipeline'ı tetiklenir.
- `metadata` (userId, teamId, botId, meetingLink, duration) toplantı kaydıyla ilişkilendir.
- `jobs:meetbot:failures` listesini de dinleyip başarısız botları işaretle (opsiyonel ama önerilir).

### 2) WhisperX planı (değişiklikler-meeting-bot.md'deki asıl iş)
Plan dosyasındaki aşamalar aynen geçerli; kısa kontrol listesi:
- [ ] `ai-service/requirements.txt`: `openai-whisper` çıkar → `whisperx==3.1.1` ekle
- [ ] `config.py`: `whisper_model=medium`, `hf_token`, `whisper_device/compute_type=auto`
- [ ] `whisper_service.py`: transcribe → align (tr wav2vec2) → diarize (pyannote) →
      `assign_word_speakers`; 3 model singleton cache
- [ ] `response_models.py`: `segments`, `speakers[]` (gerçek yüzdeler), `speaker_balance_score`
- [ ] `llm_service.py`: konuşmacı/süre tahminini kaldır (sadece topics/sentiment/key_moments)
- [ ] NestJS `analysis.service.ts`: WhisperX verisi + LLM çıktısını merge;
      `conversation_detail`'e `speaker_map` + `segments`
- [ ] `PATCH /meetings/:id/analysis/speaker-map` endpoint + DTO
- [ ] Frontend: konuşmacı satırlarına katılımcı `<select>`'i, `useUpdateSpeakerMapMutation`
- [ ] Docker: `hf_cache:/root/.cache/huggingface` volume, `HF_TOKEN` + `WHISPER_MODEL=medium` env

### 3) Tek seferlik ön koşul (HuggingFace)
- [ ] HF hesabıyla şart kabulü: `pyannote/segmentation-3.0` ve `pyannote/speaker-diarization-3.1`
- [ ] `read` yetkili HF token oluştur → ai-service `.env`'ine `HF_TOKEN` olarak ekle

### 4) Bot tetikleme (karar + küçük iş)
Ana proje bir toplantıya bot göndermek istediğinde iki seçenek:
- **a) REST** (basit): `POST http://<meeting-bot>:3000/google/join`
  (`url, name, teamId, userId, timezone, bearerToken, botId` — bkz. meeting-bot README)
- **b) Redis kuyruğu** (async, önerilen): `jobs:meetbot:list` listesine RPUSH
  (aynı alanlar + `provider: "google"|"microsoft"|"zoom"`); meeting-bot'ta
  `REDIS_CONSUMER_ENABLED=true` yapılmalı.

---

## meeting-bot'u çalıştırma (hatırlatma)
```bash
cd meeting-bot
docker compose up -d          # bot: :3000, MinIO: :9000 (konsol :9001), Redis: :6379
docker compose logs -f meeting-bot
```
Doğrulama harness'ları: `docker compose exec -T meeting-bot npx ts-node src/test/deliveryTest.ts`
