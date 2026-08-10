import type { Relay } from '../types';

export const DEFAULT_PLAYGROUND_MODEL = 'gpt-5.6-sol';

const preferredModels = [DEFAULT_PLAYGROUND_MODEL, 'gpt-5.6-luna'];

export function isPlaygroundRelayAvailable(
  relay: Pick<Relay, 'enabled'> & { balance?: Pick<NonNullable<Relay['balance']>, 'remaining'> }
): boolean {
  return relay.enabled && (relay.balance?.remaining === undefined || relay.balance.remaining === null || relay.balance.remaining >= 0);
}

export function preferredDetectedModel(values: string[], fallback: string): string {
  for (const preferred of preferredModels) {
    const match = values.find((value) => value.toLowerCase() === preferred);
    if (match) return match;
  }
  return values.find((value) => value.toLowerCase() === fallback.toLowerCase()) ?? values[0] ?? fallback;
}
