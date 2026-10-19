/** The config file `digest init` writes and every other command loads by default. */
export const DEFAULT_CONFIG_PATH = 'digest.config.json';
/** The secrets file; digest loads ./.env. */
export const DEFAULT_ENV_PATH = '.env';
/** Exists in a Docker container, so its presence tells init it runs inside one. */
export const DOCKERENV_PATH = '/.dockerenv';
