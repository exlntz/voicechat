# Звонки — видеозвонки без ВПН из России

## Обзор проекта
- **Название**: Звонки (Zvonki)
- **Цель**: Десктопное приложение для видеозвонков, которое работает из России без VPN — обходит блокировки, свойственные Discord/Zoom, за счёт собственного медиа-сервера (LiveKit SFU) на VPS в Нидерландах.
- **Ключевые возможности**:
  - Видеозвонки до 5 участников одновременно
  - Демонстрация экрана 60 FPS, до 2 одновременных демонстраций в комнате
  - Нативное .exe приложение (Electron) — демонстрация экрана работает даже если окно свёрнуто (в отличие от браузерной версии)
  - Веб-версия (та же логика) для быстрого тестирования в браузере
  - WebRTC поверх собственного TURN/TLS — устойчиво к DPI-блокировкам

## URL
- **Production backend (Cloudflare Worker)**: https://d64f63e0-da2a-4f9a-a681-de51ac697dac.vip.gensparksite.com
- **LiveKit медиа-сервер (VPS, Нидерланды)**: wss://livekit.185.199.199.114.nip.io
- **Скачать .exe (Windows)**: собирается из `/home/user/electron-app` (см. раздел "Сборка .exe")

## Архитектура
```
[Electron .exe / Браузер]
        │  HTTPS (получение JWT-токена)
        ▼
[Cloudflare Worker — Hono]  ← control-plane: комнаты, лимиты, токены (этот репозиторий)
        │  хранит комнаты в D1
        ▼
[LiveKit SFU на VPS 185.199.199.114] ← медиа-сервер: WebRTC SFU + TURN
```

- **Control-plane** (этот проект, `/home/user/webapp`) — Cloudflare Worker на Hono: создаёт комнаты, генерирует JWT-токены доступа к LiveKit, следит за лимитами участников (5) и демонстраций экрана (2).
- **Медиа-сервер** — LiveKit (self-hosted, Docker) на VPS в Нидерландах (185.199.199.114). Обрабатывает весь видео/аудио трафик через SFU (Selective Forwarding Unit), с TURN/TLS для обхода блокировок.
- **Клиент** — общий HTML/CSS/JS (`public/static/app.js`), который открывается либо в браузере, либо внутри Electron-обёртки (`/home/user/electron-app`, отдельная папка, не деплоится на Cloudflare).

## Данные и хранилище
- **Cloudflare D1** (`DB` binding) — таблица `rooms(code, created_at, last_active)`, история комнат
- **LiveKit RoomService** — источник правды по текущим участникам/трекам (не хранится в D1)
- **Секреты**: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — установлены как Cloudflare secrets (не в коде/git)
- **Переменные окружения** (`wrangler.jsonc` → `vars`): `LIVEKIT_URL`, `LIVEKIT_HTTP_URL`

## API эндпоинты (control-plane)
- `POST /api/rooms` — создать новую комнату, возвращает `{roomCode}`
- `POST /api/join` — войти в комнату (body: `{roomCode, displayName}`), возвращает `{token, url, roomCode, identity, displayName, maxParticipants, maxScreenShares}`. Возвращает 403 `{error:'room_full'}` если участников уже 5.
- `GET /api/rooms/:code/screen-shares` — текущее число активных демонстраций экрана в комнате, `{current, max, available}`
- `GET /api/rooms/:code` — информация о комнате: `{exists, participantCount, maxParticipants, participants}`
- `GET /` , `GET /room/:code` — HTML страницы (лобби / комната звонка)

## Как это работает (пользовательский сценарий)
1. Открыть .exe приложение (или веб-страницу)
2. Ввести имя, оставить поле кода комнаты пустым (создаст новую) или ввести код существующей комнаты
3. Разрешить доступ к камере/микрофону
4. Поделиться кодом комнаты с другими участниками (до 5 человек)
5. Кнопка "Демонстрация экрана" — выбрать окно/экран из нативного диалога (до 2 одновременных демонстраций на комнату), 60 FPS

## Инфраструктура (VPS, не в этом репозитории)
- **VPS**: 185.199.199.114 (Нидерланды, 4 vCPU/8GB/175GB SSD, Ubuntu 22.04)
- **LiveKit**: Docker-контейнер (`--network host`), конфиг в `/opt/livekit/livekit.yaml`, порты 7880 (WSS через nginx на 443), RTC UDP 50000-60000, TURN 3478/UDP + 5349/TLS
- **nginx**: реверс-прокси для WSS-сигналинга (443 → 7880), SSL через Let's Encrypt/certbot (домен `livekit.185.199.199.114.nip.io`, автопродление)
- **UFW**: открыты только нужные порты (22, 80, 443, 50000-60000/udp, 7881/tcp, 3478/udp, 5349/tcp)
- Сервисы настроены на автозапуск (`docker --restart unless-stopped`, `systemctl enable nginx`, `ufw` persistent) — переживают перезагрузку сервера

## Сборка .exe (Electron)
Электрон-проект лежит отдельно в `/home/user/electron-app` (не деплоится на Cloudflare, не входит в этот репозиторий).
```bash
cd /home/user/electron-app
npm install
npx electron-builder --win portable --x64
# Результат: release/Zvonki-Setup.exe
```
URL backend'а задаётся в `electron-app/src/main.js` (переменная `SERVER_URL`), по умолчанию указывает на production Cloudflare Worker.

## Реализовано
- ✅ LiveKit SFU медиа-сервер развёрнут и работает (проверено сквозное тестирование: JWT-токен → `/rtc/validate` → success)
- ✅ Cloudflare Worker control-plane (комнаты, токены, лимиты) — задеплоен на production
- ✅ Веб-фронтенд (лобби, комната звонка, управление камерой/микрофоном/демонстрацией экрана)
- ✅ Electron-обёртка с нативным выбором экрана (desktopCapturer + собственный UI пикера)
- ✅ Собран рабочий .exe (Windows portable, 70 МБ)
- ✅ Лимиты соблюдаются на уровне сервера: 5 участников, 2 демонстрации экрана

## Не реализовано / следующие шаги
- ⏳ Полноценный инсталлятор (NSIS с иконкой, автообновление) — сейчас только portable .exe
- ⏳ Индикатор активного говорящего (базовая версия есть, можно улучшить визуально)
- ⏳ Список участников (боковая панель, задел в CSS есть, не подключена кнопка)
- ⏳ Уведомления о достижении лимита демонстраций экрана в реальном времени (сейчас проверка при клике)
- ⏳ Тест реального звонка с 5 живыми участниками и 2 демонстрациями экрана одновременно на сети из России

## Деплой
- **Platform**: Cloudflare Workers (через управляемый хостинг Genspark, Workers for Platform)
- **Статус**: ✅ Активен
- **Стек**: Hono + TypeScript + Cloudflare D1 + LiveKit (self-hosted SFU)
- **Обновлено**: 2026-08-28
