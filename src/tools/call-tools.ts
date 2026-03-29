import type { TelegramClient } from '@mtcute/bun';
import type { ToolInfo } from './index.js';
import Long from 'long';

export const callTools: ToolInfo[] = [
  {
    name: 'call_request',
    description: 'Initiate a phone call to a user (ring their phone). The call will be automatically discarded after a short delay. Only works with individual users, not groups or channels.',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: {
          type: 'string',
          description: 'User ID or username to call',
        },
        video: {
          type: 'boolean',
          description: 'Whether to initiate a video call (default: false)',
          default: false,
        },
        ringDurationSeconds: {
          type: 'number',
          description: 'How long to let it ring before hanging up in seconds (default: 15, max: 60)',
          default: 15,
        },
      },
      required: ['chatId'],
    },
  },
];

export async function handleCallTools(
  name: string,
  args: any,
  client: TelegramClient
) {
  switch (name) {
    case 'call_request':
      return await requestCall(client, args);
    default:
      throw new Error(`Unknown call tool: ${name}`);
  }
}

async function requestCall(client: TelegramClient, args: any) {
  const { chatId, video = false, ringDurationSeconds = 15 } = args;
  const ringMs = Math.min(ringDurationSeconds, 60) * 1000;

  try {
    const userId = await client.resolveUser(
      Number.isNaN(Number(chatId)) ? chatId : Number(chatId)
    );

    // DH key exchange: Telegram requires a valid gAHash = SHA-256(g_a)
    const dhConfig = await client.call({
      _: 'messages.getDhConfig',
      version: 0,
      randomLength: 256,
    });

    if (dhConfig._ !== 'messages.dhConfig') {
      throw new Error('Failed to get DH config');
    }

    const { p, g: gInt } = dhConfig;
    const a = new Uint8Array(256);
    crypto.getRandomValues(a);

    // Compute g_a = g^a mod p using BigInt
    const pBig = bytesToBigInt(p);
    const aBig = bytesToBigInt(a);
    const gBig = BigInt(gInt);
    const gA = modPow(gBig, aBig, pBig);
    const gABytes = bigIntToBytes(gA, 256);
    const gAHashBuffer = await crypto.subtle.digest('SHA-256', new Uint8Array(gABytes));
    const gAHash = new Uint8Array(gAHashBuffer);

    const result = await client.call({
      _: 'phone.requestCall',
      video,
      userId,
      randomId: Math.floor(Math.random() * 0x7fffffff),
      gAHash,
      protocol: {
        _: 'phoneCallProtocol',
        udpP2p: true,
        udpReflector: true,
        minLayer: 92,
        maxLayer: 92,
        libraryVersions: ['5.0.0'],
      },
    });

    const phoneCall = result.phoneCall;

    if (!phoneCall || phoneCall._ === 'phoneCallEmpty' || phoneCall._ === 'phoneCallDiscarded') {
      throw new Error('Failed to initiate call - received empty response');
    }

    // Wait for ring duration
    await new Promise(resolve => setTimeout(resolve, ringMs));

    // Discard the call
    try {
      const discardResult = await client.call({
        _: 'phone.discardCall',
        video,
        peer: {
          _: 'inputPhoneCall',
          id: phoneCall.id,
          accessHash: phoneCall.accessHash,
        },
        duration: 0,
        reason: { _: 'phoneCallDiscardReasonHangup' },
        connectionId: Long.ZERO,
      });
      client.handleClientUpdate(discardResult);
    } catch {
      // Call may have already been discarded by the other party
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            callId: phoneCall.id.toString(),
            video,
            ringDurationSeconds: Math.min(ringDurationSeconds, 60),
          }, null, 2),
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error initiating call: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) {
      result = (result * base) % mod;
    }
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}
