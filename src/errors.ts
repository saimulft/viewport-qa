/** Thrown for invalid input: an unknown check id, a bad width, an unsupported URL. The CLI exits with code 2. */
export class UsageError extends Error {
  override name = 'UsageError';
}
