# openmetro-client

Fully typed [Eden Treaty](https://elysiajs.com/eden/treaty/overview) client for
the Open Metro API. Request and response types are generated from the server's
own Elysia app — there is no hand-written contract.

```bash
# From the published client branch (preferred)
npm install github:Naptie/openmetro#client elysia @elysia/eden effect

# Or from a release tarball
npm install <path-or-url-to>/openmetro-client-0.1.0.tgz
npm install elysia @elysia/eden effect
```

```ts
import { createClient } from "openmetro-client";

const metro = createClient("http://127.0.0.1:8790");
const { data } = await metro.api.networks({ id: "cn-bj" }).stations.get();
```

## Derived entity types

Named response types are exported too, all inferred from the API:

```ts
import type { ApiLine, ApiRoutePlan, ApiStation } from "openmetro-client";

const mode: ApiLine["mode"] = "metro";
```

`ApiSuccess<Route>` unwraps the success payload of any route method:

```ts
import type { ApiSuccess, Client } from "openmetro-client";

type Networks = ApiSuccess<Client["api"]["networks"]["get"]>;
```

## Runtime validation schemas

The `./schemas` subpath ships zod schemas for every documented response
shape, generated from the same wire schemas the server validates against
(single source of truth):

```bash
npm install zod  # optional peer, only needed for the ./schemas subpath
```

```ts
import { apiRoutePlanSchema } from "openmetro-client/schemas";

const result = apiRoutePlanSchema.safeParse(plan);
if (!result.success) console.log(result.error);
```

Every schema is also reachable through the `apiSchemas` map keyed by its
wire name (`ApiLine`, `ApiRoutePlan`, ...).