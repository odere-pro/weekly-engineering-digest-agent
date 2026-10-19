const URL_CREDENTIALS = /(\bhttps?:\/\/)[^\s/@]+@/g;

/** `https://user:pass@host` becomes `https://host`: credentials in a URL must not reach pasted output. */
export function withoutUrlCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, '$1');
}
