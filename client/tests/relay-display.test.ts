import { describe, expect, it } from 'vitest';
import { displayRelayUrl } from '../src/utils/relay-display';

describe('displayRelayUrl', () => {
  it('removes a trailing /v1 path from the displayed URL', () => {
    expect(displayRelayUrl('https://api.example.com/v1')).toBe('https://api.example.com');
    expect(displayRelayUrl('https://api.example.com/v1/')).toBe('https://api.example.com');
    expect(displayRelayUrl('https://api.example.com/API/v1?source=relay#home')).toBe(
      'https://api.example.com/API?source=relay#home'
    );
  });

  it('keeps URLs without a trailing /v1 path unchanged', () => {
    expect(displayRelayUrl('https://api.example.com')).toBe('https://api.example.com');
    expect(displayRelayUrl('https://api.example.com/v1/models')).toBe('https://api.example.com/v1/models');
  });

  it('falls back to text formatting for invalid URL values', () => {
    expect(displayRelayUrl('api.example.com/v1')).toBe('api.example.com');
  });
});
