// src/index.ts
import { treaty } from "@elysia/eden";
var createClient = (baseUrl, config) => treaty(baseUrl, config);
export {
  createClient
};
