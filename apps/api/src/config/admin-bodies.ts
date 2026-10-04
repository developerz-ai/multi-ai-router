import { atLeastOne } from "./fields"
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
      maximumJsonBytes: raw.ADMIN_JSON_MAX_BYTES ?? 1024 * 1024,
      maximumLoginJsonBytes: raw.ADMIN_LOGIN_JSON_MAX_BYTES ?? 8 * 1024,
    },
  }
}
