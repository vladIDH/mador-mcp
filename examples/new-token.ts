import { generateToken } from "../src/index.js";

/**
 * `npm run token`: a new per-user token. Give the token to the user, store
 * only the hash (e.g. next to the user in your database).
 */
const { token, hash } = generateToken(process.argv[2] ?? "mcp_");
console.log(`token (give it to the user, once): ${token}`);
console.log(`hash  (store this):                ${hash}`);
