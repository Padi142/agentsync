import type { DeviceAuthorization, DevicePollResult, MachineOs, Target } from '@agentsync/contract';
import { eq, lte } from 'drizzle-orm';
import { createDb } from './db';
import { hashSecret, registerMachine } from './db/machines';
import { deviceAuthorization } from './db/schema';
import { provisionUser, type WorkOSIdentity } from './db/users';
import type { Env } from './env';

// WorkOS AuthKit CLI Auth: https://workos.com/docs/user-management/cli-auth
const WORKOS_API = 'https://api.workos.com/user_management';
/** RFC 8628 §3.5: after `slow_down`, wait 5 seconds longer for every later poll. */
const SLOW_DOWN_SECONDS = 5;

function postForm(path: string, fields: Record<string, string>) {
  return fetch(`${WORKOS_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields),
  });
}

/**
 * Start a WorkOS device flow and remember its code (as a hash) so that polls can be
 * checked, slowed down and used once. Forgets flows that have expired.
 */
export async function startDeviceFlow(env: Env): Promise<DeviceAuthorization> {
  const response = await postForm('/authorize/device', { client_id: env.WORKOS_CLIENT_ID });
  if (!response.ok) throw new Error(`WorkOS device authorization failed with ${response.status}.`);
  const body = await response.json() as {
    device_code: string; user_code: string; verification_uri: string;
    verification_uri_complete: string; expires_in: number; interval: number;
  };
  const db = createDb(env);
  await db.batch([
    db.delete(deviceAuthorization).where(lte(deviceAuthorization.expiresAt, new Date())),
    db.insert(deviceAuthorization).values({
      deviceCodeHash: await hashSecret(body.device_code),
      interval: body.interval,
      expiresAt: new Date(Date.now() + body.expires_in * 1000),
    }),
  ]);
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete,
    expiresIn: body.expires_in,
    interval: body.interval,
  };
}

/**
 * Poll a device flow this server started. On approval, provision the user and register
 * the Machine; a code is used at most once, so every later poll with it is `invalid`.
 */
export async function pollDeviceFlow(
  env: Env,
  input: { deviceCode: string; name: string; os: MachineOs; targets: Target[] },
): Promise<DevicePollResult> {
  const db = createDb(env);
  const hash = await hashSecret(input.deviceCode);
  const flow = await db.select().from(deviceAuthorization).where(eq(deviceAuthorization.deviceCodeHash, hash)).get();
  if (!flow) return { status: 'invalid' };
  const forget = () => db.delete(deviceAuthorization).where(eq(deviceAuthorization.deviceCodeHash, hash)).run();
  if (flow.expiresAt.getTime() <= Date.now()) {
    await forget();
    return { status: 'expired' };
  }

  const response = await postForm('/authenticate', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: input.deviceCode,
    client_id: env.WORKOS_CLIENT_ID,
  });
  const body = await response.json().catch(() => ({})) as { error?: string; user?: Record<string, unknown> };
  if (response.ok && body.user) {
    const user = await provisionUser(env, toIdentity(body.user));
    const registered = await registerMachine(env, hash, user.id, input);
    return registered ? { status: 'approved', ...registered } : { status: 'invalid' };
  }
  switch (body.error) {
    case 'authorization_pending':
      return { status: 'pending', interval: flow.interval };
    case 'slow_down': {
      const interval = flow.interval + SLOW_DOWN_SECONDS;
      await db.update(deviceAuthorization).set({ interval }).where(eq(deviceAuthorization.deviceCodeHash, hash)).run();
      return { status: 'pending', interval };
    }
    case 'access_denied':
      await forget();
      return { status: 'denied' };
    case 'expired_token':
      await forget();
      return { status: 'expired' };
    case 'invalid_grant':
      await forget();
      return { status: 'invalid' };
    default:
      // A WorkOS outage is not a verdict on the code: keep it so the CLI can poll again.
      throw new Error(`WorkOS device poll failed with ${response.status}.`);
  }
}

function toIdentity(user: Record<string, unknown>): WorkOSIdentity {
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const id = text(user.id);
  const email = text(user.email);
  if (!id || !email) throw new Error('WorkOS approved a device without a user.');
  return {
    id,
    email,
    firstName: text(user.first_name),
    lastName: text(user.last_name),
    emailVerified: user.email_verified === true,
    profilePictureUrl: text(user.profile_picture_url),
  };
}
