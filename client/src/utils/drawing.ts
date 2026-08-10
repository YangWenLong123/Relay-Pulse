export const DEFAULT_DRAWING_MODEL = 'gpt-image-1';

const preferredDrawingModels = [DEFAULT_DRAWING_MODEL, 'gpt-image-1.5', 'gpt-image-2'];

export function preferredDrawingModel(values: string[], fallback = ''): string {
  for (const preferred of preferredDrawingModels) {
    const match = values.find((value) => value.toLowerCase() === preferred);
    if (match) return match;
  }
  return values.find((value) => value.toLowerCase() === fallback.toLowerCase()) ?? values[0] ?? fallback;
}
