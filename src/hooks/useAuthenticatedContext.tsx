import * as React from 'react';
import {Client, Room} from 'colyseus.js';

import {State} from '../../../server/src/entities/State';
import {GAME_NAME} from '../../../server/src/shared/Constants';

import {discordSdk} from '../discordSdk';
import LoadingScreen from '../components/LoadingScreen';
import {getUserAvatarUrl} from '../utils/getUserAvatarUrl';

import type {IGuildsMembersRead, TAuthenticateResponse, TAuthenticatedContext} from '../types';
import {getUserDisplayName} from '../utils/getUserDisplayName';

import { v4 as uuidv4 } from 'uuid';
import {DiscordSDK} from "@discord/embedded-app-sdk";
import {Channel} from "@discord/embedded-app-sdk/output/schema/types";


const AuthenticatedContext = React.createContext<TAuthenticatedContext>({
    user: {
        id: '',
        username: '',
        discriminator: '',
        avatar: null,
        public_flags: 0,
    },
    access_token: '',
    scopes: [],
    expires: '',
    application: {
        rpc_origins: undefined,
        id: '',
        name: '',
        icon: null,
        description: '',
    },
    guildMember: null,
    client: undefined as unknown as Client,
    room: undefined as unknown as Room,
});

export function AuthenticatedContextProvider({children}: {children: React.ReactNode}) {
    const authenticatedContext = useAuthenticatedContextSetup();

    if (authenticatedContext == null) {
        return <LoadingScreen />;
    }

    return <AuthenticatedContext.Provider value={authenticatedContext}>{children}</AuthenticatedContext.Provider>;
}

export function useAuthenticatedContext() {
    return React.useContext(AuthenticatedContext);
}

/**
 * This is a helper hook which is used to connect your embedded app with Discord and Colyseus
 */
function useAuthenticatedContextSetup() {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const [auth, setAuth] = React.useState<TAuthenticatedContext | null>(null);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const settingUp = React.useRef(false);

    // eslint-disable-next-line react-hooks/rules-of-hooks
    React.useEffect(() => {
        const setUpDiscordSdk = async () => {
            try {
                await discordSdk.ready();

                const {code} = await discordSdk.commands.authorize({
                    client_id: import.meta.env.VITE_CLIENT_ID,
                    response_type: "code",
                    state: "",
                    prompt: "none",
                    scope: [
                        "identify",
                        "rpc.activities.write",
                        "guilds.members.read",
                        "rpc.voice.read",
                        "guilds",
                    ],
                });

                // Retrieve an access_token from your embedded app's server
                const response = await fetch("/api/token", {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        code,
                    }),
                });

                const {access_token} = await response.json();

                // Authenticate with Discord client (using the access_token)
                const newAuth: TAuthenticateResponse = await discordSdk.commands.authenticate({
                    access_token,
                });

                // Get guild specific nickname and avatar, and fallback to user name and avatar
                const guildMember: IGuildsMembersRead | null = await fetch(
                    `https://discord.com/api/users/@me/guilds/${discordSdk.guildId}/member`,
                    {
                        method: 'get',
                        headers: {Authorization: `Bearer ${access_token}`},
                    }
                )
                    .then((j) => j.json())
                    .catch(() => {
                        return null;
                    });

                // Done with discord-specific setup

                // Now we create a colyseus client
                const wsUrl = `wss://${location.host}/api/colyseus`;
                const client = new Client(wsUrl);

                let roomName = 'Channel';

                // Requesting the channel in GDMs (when the guild ID is null) requires
                // the dm_channels.read scope which requires Discord approval.
                if (discordSdk.channelId != null && discordSdk.guildId != null) {
                    // Over RPC collect info about the channel
                    const channel = await discordSdk.commands.getChannel({channel_id: discordSdk.channelId});
                    if (channel.name != null) {
                        roomName = channel.name;
                    }
                }

                // Get the user's guild-specific avatar uri
                // If none, fall back to the user profile avatar
                // If no main avatar, use a default avatar
                const avatarUri = getUserAvatarUrl({
                    guildMember,
                    user: newAuth.user,
                });

                // Get the user's guild nickname. If none set, fall back to global_name, or username
                // Note - this name is note guaranteed to be unique
                const name = getUserDisplayName({
                    guildMember,
                    user: newAuth.user,
                });

                // The second argument has to include for the room as well as the current player
                const newRoom = await client.joinOrCreate<State>(GAME_NAME, {
                    channelId: discordSdk.channelId,
                    roomName,
                    userId: newAuth.user.id,
                    name,
                    avatarUri,
                });

                await discordSdk.commands.setActivity({
                    activity: {
                        timestamps: {
                            start: Math.floor(Date.now() / 1000),
                        },
                        details: "Watching Twitch",
                        state: 'Papaplatte',
                        type: 3,
                        instance: true,
                    },
                });

                // Finally, we construct our authenticatedContext object to be consumed throughout the app
                setAuth({...newAuth, guildMember, client, room: newRoom});
            } catch (error) {
                console.error('An error occurred:', error);
            }
        }

        if (!settingUp.current) {
            settingUp.current = true;
            setUpDiscordSdk();
        }
    }, []);

    return auth;
}
