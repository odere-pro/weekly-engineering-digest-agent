// @ts-check
// The local ESLint plugin `digest`: this project's own rules. Registered in eslint.config.js.
// To add a rule, see eslint-rules/README.md.
import { fetchRedirect } from './fetchRedirect.mjs';

/** @type {import('eslint').ESLint.Plugin} */
export const digest = {
  meta: { name: 'eslint-plugin-digest' },
  rules: {
    'fetch-redirect': fetchRedirect,
  },
};
