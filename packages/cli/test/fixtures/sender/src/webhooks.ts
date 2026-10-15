import { webhooks } from "@typedhook/sdk";
import { billingEvents } from "../../../../../verify/test/fixtures/billing";

export const wh = webhooks({ events: billingEvents, subscribers: [] });
export default wh;
