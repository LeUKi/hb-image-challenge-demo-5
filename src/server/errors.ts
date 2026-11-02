export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
