import 'dotenv/config';
import Pusher from 'pusher';

const CANDIDATE_CLUSTERS = ['mt1', 'ap1', 'ap2', 'ap3', 'ap4', 'eu', 'us2', 'us3', 'sa1'];

const appId = (process.env.PUSHER_APP_ID || '').trim();
const key = (process.env.PUSHER_KEY || process.env.PUSHER_APP_KEY || '').trim();
const secret = (process.env.PUSHER_SECRET || process.env.PUSHER_APP_SECRET || '').trim();
const initialCluster = (process.env.PUSHER_CLUSTER || 'ap1').trim();
const enabledFlag = (process.env.PUSHER_ENABLED || 'true').trim().toLowerCase();

const isConfigured =
  enabledFlag !== 'false' &&
  Boolean(appId && key && secret) &&
  !appId.startsWith('your_') &&
  !key.startsWith('your_') &&
  !secret.startsWith('your_');

let activeClient: Pusher | null = isConfigured
  ? new Pusher({
    appId,
    key,
    secret,
    cluster: initialCluster,
    useTLS: true,
  })
  : null;

let circuitBroken = !isConfigured;
let discoveryPromise: Promise<Pusher | null> | null = null;
let loggedDisabled = false;

const logDisabledOnce = (reason: string) => {
  if (loggedDisabled) return;
  loggedDisabled = true;
  console.warn(
    `⚠️ [Pusher] ${reason} Realtime WebSocket dinonaktifkan sementara (chat tetap berjalan realtime via auto-polling REST; perbarui PUSHER_APP_ID/KEY/SECRET/CLUSTER di .env jika membuat App Pusher baru).`
  );
};

const discoverWorkingCluster = async (): Promise<Pusher | null> => {
  if (!isConfigured) return null;
  if (discoveryPromise) return discoveryPromise;

  discoveryPromise = (async () => {
    const others = CANDIDATE_CLUSTERS.filter((c) => c !== initialCluster);
    for (const c of others) {
      const candidate = new Pusher({
        appId,
        key,
        secret,
        cluster: c,
        useTLS: true,
      });
      try {
        const res = await candidate.get({ path: '/channels' });
        if (res && res.status === 200) {
          activeClient = candidate;
          circuitBroken = false;
          console.log(`✅ [Pusher] Cluster otomatis disesuaikan ke '${c}'.`);
          return candidate;
        }
      } catch {
        // Coba cluster berikutnya
      }
    }

    circuitBroken = true;
    logDisabledOnce(`App Key '${key}' tidak aktif/tidak ditemukan di server Pusher.`);
    return null;
  })();

  try {
    return await discoveryPromise;
  } finally {
    discoveryPromise = null;
  }
};

export const isPusherAvailable = (): boolean => Boolean(activeClient && !circuitBroken);

export const pusher = {
  async trigger(
    channels: string | string[],
    event: string,
    data: any,
    params?: Pusher.TriggerParams
  ): Promise<Pusher.Response | undefined> {
    if (!isPusherAvailable() || !activeClient) {
      return undefined;
    }

    try {
      return await activeClient.trigger(channels, event, data, params);
    } catch (err: any) {
      const status = Number(err?.status || 0);
      const bodyStr = String(err?.body || '');

      if (status === 400 && bodyStr.includes('not in this cluster')) {
        const discovered = await discoverWorkingCluster();
        if (discovered) {
          try {
            return await discovered.trigger(channels, event, data, params);
          } catch (retryErr: any) {
            console.warn(
              `⚠️ [Pusher] Gagal mengirim event '${event}' setelah pindah cluster: ${retryErr?.message || retryErr}`
            );
            return undefined;
          }
        }
        return undefined;
      }

      if (status === 401 || status === 403 || status === 404) {
        circuitBroken = true;
        logDisabledOnce(`Kredensial Pusher ditolak (HTTP ${status}).`);
        return undefined;
      }

      console.warn(`⚠️ [Pusher] Gagal mengirim event '${event}': ${err?.message || err}`);
      return undefined;
    }
  },

  authorizeChannel(socketId: string, channel: string, data?: Pusher.PresenceChannelData): Pusher.ChannelAuthResponse {
    if (!activeClient) {
      throw new Error('Pusher client belum terkonfigurasi');
    }
    return activeClient.authorizeChannel(socketId, channel, data);
  },

  authenticateUser(socketId: string, userData: Pusher.UserChannelData): Pusher.UserAuthResponse {
    if (!activeClient) {
      throw new Error('Pusher client belum terkonfigurasi');
    }
    return activeClient.authenticateUser(socketId, userData);
  },
};

export default pusher;
