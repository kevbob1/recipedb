/**
 * THROWAWAY PROTOTYPE — issue #17.
 *
 * Vite replaces `import.meta.env.DEV` at build time. Read it through a cast so
 * the prototype does not depend on the app's ambient Vite type declarations.
 */

const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;

/** True in `npm run dev`, false in `npm run build` output. */
export const IS_DEV_BUILD: boolean = env?.DEV === true;
