import 'dotenv/config';
import Pusher from 'pusher';
export declare const isPusherAvailable: () => boolean;
export declare const pusher: {
    trigger(channels: string | string[], event: string, data: any, params?: Pusher.TriggerParams): Promise<Pusher.Response | undefined>;
    authorizeChannel(socketId: string, channel: string, data?: Pusher.PresenceChannelData): Pusher.ChannelAuthResponse;
    authenticateUser(socketId: string, userData: Pusher.UserChannelData): Pusher.UserAuthResponse;
};
export default pusher;
//# sourceMappingURL=pusher.d.ts.map