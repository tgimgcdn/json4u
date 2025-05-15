"use server";
export const runtime = 'edge';

import { env } from "@/lib/env";
import { SubscriptionType, WebhookRequest, type TWebhookRequest } from "@/lib/shop/types";
import { Db } from "@/lib/supabase/server";
import type { Order } from "@/lib/supabase/table.types";
import crypto from "node:crypto";

// Test mode: https://docs.lemonsqueezy.com/help/getting-started/test-mode#test-card-numbers
export async function POST(request: Request) {
  const eventName = request.headers.get("X-Event-Name");
  const ua = request.headers.get("User-Agent");
  const body = await request.text();

  // sometimes subscription_created will be sent with a null body for a unknown reason
  if (!body) {
    console.error(`Empty rawBody: event[${eventName}] ua[${ua}]`);
    return new Response("Invalid signature", { status: 400 });
  }

  const hmac = crypto.createHmac("sha256", env.LEMONSQUEEZY_WEBHOOK_SECRET);
  const digest = Buffer.from(hmac.update(body).digest("hex"), "utf8");
  const signature = Buffer.from(request.headers.get("X-Signature") || "", "utf8");

  if (!crypto.timingSafeEqual(digest, signature)) {
    console.error(
      `Invalid signature: event[${eventName}] ua[${ua}] digest[${digest}] signature[${signature}] body[${body}]`,
    );
    return new Response("Invalid signature", { status: 400 });
  }

  const req = JSON.parse(body);
  const { success, error, data: webhookReq } = WebhookRequest.safeParse(req);

  if (!success) {
    return new Response(`Data invalid: ${error}`, { status: 400 });
  }

  const { error: err } = await handle(webhookReq);

  if (err) {
    console.error(`Handle webhook event failed (${err}): body[${body}]`);
    return new Response(err, { status: 500 });
  } else {
    const data = webhookReq?.data;
    console.log(
      `Handle ${webhookReq?.meta?.event_name} success. subscription_id[${data?.id}] email[${data?.attributes?.user_email}]`,
    );
    return new Response("OK", { status: 200 });
  }
}

/* https://docs.lemonsqueezy.com/help/webhooks#events-sent-during-a-subscriptions-lifecycle
Initial order is placed:
1. subscription_created
2. subscription_payment_success
*/
async function handle(req: TWebhookRequest): Promise<{ error: string }> {
  const db = new Db();
  const { user_email, order_id, status, renews_at, ends_at, variant_id } = req.data.attributes;
  const order: Order = {
    // the same email address will represent a single user:
    // https://supabase.com/docs/guides/auth/auth-identity-linking#automatic-linking
    email: user_email,
    id: order_id,
    subscription_id: req.data.id,
    status,
    plan: "free",
    renews_at,
    ends_at,
    variant_id,
  };
  order.plan = getPlan(order);

  try {
    await db.upsertOrder(order);
  } catch (error: any) {
    console.error("DB access failed:", error, order);
    return { error: error.message };
  }

  return { error: "" };
}

function getPlan(order: Order): SubscriptionType {
  switch (order.status) {
    case "unpaid":
      return "free";
    case "expired":
      return "free";
  }

  for (const [t, id] of Object.entries(env.LEMONSQUEEZY_SUBSCRIPTION_VARIANT_MAP)) {
    if (order.variant_id === id) {
      return t as SubscriptionType;
    }
  }

  console.error(`Unknown variant_id: ${order.variant_id}`);
  return "free";
}
