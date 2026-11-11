import { atLeastOne } from "./fields"

/** The one place the admin JSON body caps default (01.15); routes and `listen.ts` import these. */
export const DEFAULT_ADMIN_JSON_MAX_BYTES = 1024 * 1024
export const DEFAULT_ADMIN_LOGIN_JSON_MAX_BYTES = 8 * 1024

export const ADMIN_BODY_ENV_FIELDS = {
  ADMIN_JSON_MAX_BYTES: atLeastOne.optional(),
  ADMIN_LOGIN_JSON_MAX_BYTES: atLeastOne.optional(),
}
export function readAdminBodiesEnv(raw: {
  ADMIN_JSON_MAX_BYTES?: number
  ADMIN_LOGIN_JSON_MAX_BYTES?: number
}) {
  return {
    adminBodies: {
      maximumJsonBytes: raw.ADMIN_JSON_MAX_BYTES ?? DEFAULT_ADMIN_JSON_MAX_BYTES,
      maximumLoginJsonBytes: raw.ADMIN_LOGIN_JSON_MAX_BYTES ?? DEFAULT_ADMIN_LOGIN_JSON_MAX_BYTES,
    },
  }
}
