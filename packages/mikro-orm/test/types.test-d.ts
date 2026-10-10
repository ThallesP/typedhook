/**
 * Compile-time contract. Checked by `tsc --noEmit`, never executed: the
 * transactional EntityManager is accepted by `with()`, anything else isn't.
 */
import { MikroORM, type EntityManager } from "@mikro-orm/postgresql";
import { outbox, webhooks } from "@thallesp/webhooks";
import { z } from "zod";
import { WebhookOutbox, mikroOrmOutboxAdapter } from "../src/index";

export async function withTakesTheTransactionalEntityManager(orm: MikroORM) {
  const wh = webhooks({
    events: { "user.created": z.object({ userId: z.string() }) },
    subscribers: [{ url: "https://consumer.test/hook" }],
    signing: { secret: "s" },
    delivery: outbox(mikroOrmOutboxAdapter(orm.em, { entity: WebhookOutbox })),
  });

  await orm.em.transactional(async (em) => {
    await wh.with(em).send({ event: "user.created", subject: "u_1", data: { userId: "u_1" } });
  });

  // @ts-expect-error not an EntityManager
  wh.with({ query: () => {} });
}

export async function explicitDriverEntityManager(orm: MikroORM) {
  const wh = webhooks({
    events: { "user.created": z.object({ userId: z.string() }) },
    subscribers: [{ url: "https://consumer.test/hook" }],
    signing: { secret: "s" },
    delivery: outbox(mikroOrmOutboxAdapter<EntityManager>(orm.em)),
  });

  await orm.em.transactional(async (em) => {
    await wh.with(em).send({ event: "user.created", subject: "u_1", data: { userId: "u_1" } });
  });
}
