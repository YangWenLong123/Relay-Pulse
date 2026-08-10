import { describe, expect, it } from 'vitest';
import { DEFAULT_DRAWING_MODEL, preferredDrawingModel } from '../src/utils/drawing';

describe('preferredDrawingModel', () => {
  it('uses GPT Image 1 as the drawing default', () => {
    expect(DEFAULT_DRAWING_MODEL).toBe('gpt-image-1');
  });

  it('prefers GPT Image 1, then 1.5, then 2', () => {
    expect(preferredDrawingModel(['gpt-image-2', 'gpt-image-1.5', 'GPT-IMAGE-1'], 'dall-e-3')).toBe('GPT-IMAGE-1');
    expect(preferredDrawingModel(['gpt-image-2', 'gpt-image-1.5'], 'dall-e-3')).toBe('gpt-image-1.5');
    expect(preferredDrawingModel(['dall-e-3', 'gpt-image-2'], 'dall-e-3')).toBe('gpt-image-2');
  });

  it('falls back to the saved model before the first available model', () => {
    expect(preferredDrawingModel(['dall-e-2', 'dall-e-3'], 'DALL-E-3')).toBe('dall-e-3');
    expect(preferredDrawingModel(['dall-e-2'], 'gpt-image-1')).toBe('dall-e-2');
  });
});
