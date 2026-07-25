/**
 * Netlify function entry — delegates to the Fastify app.
 *
 * Kept as a thin re-export so all server logic lives in api/src and can be run
 * locally with `npm run dev` without any Netlify tooling.
 */

export { default, config } from "../../api/src/netlify.js";
