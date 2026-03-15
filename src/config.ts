// meridian-roles runtime configuration
// All values overridable via environment variables — no hard-coded production paths

export const HUB_SOCKET_PATH   = process.env.HUB_SOCKET_PATH   ?? '/tmp/hub-socks/hub-core.sock';
export const ROLES_SOCKET_PATH = process.env.ROLES_SOCKET_PATH ?? '/tmp/meridian-roles.sock';
export const GUI_PORT          = Number(process.env.GUI_PORT    ?? 7701);
export const STATE_FILE_PATH   = process.env.STATE_FILE_PATH   ?? '/var/lib/meridian-roles/state.json';
export const ROLES_SERVICE_ID  = 'service:meridian-roles';
