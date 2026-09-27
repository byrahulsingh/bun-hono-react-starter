import { api } from './api'

export interface Health {
  env: string
  /** Seconds since the API process started. */
  uptime: number
}

/** Endpoints for the API's public health check. */
export const healthApi = {
  get: (signal?: AbortSignal) => api.get<Health>('/health', { signal }),
}
