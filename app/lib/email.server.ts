import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = "COD King <onboarding@codking.app>";
const CRISP_CHAT_URL =
  "https://go.crisp.chat/chat/embed/?website_id=ff03bb91-3897-4f27-b66f-a3dafceeba4e";

function emailShell(title: string, headerBg: string, headerEmoji: string, body: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:${headerBg};padding:36px 40px;text-align:center;">
              <div style="font-size:40px;margin-bottom:10px;">${headerEmoji}</div>
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:800;letter-spacing:-0.5px;">${title}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 40px 32px;">
              ${body}
            </td>
          </tr>
          <tr>
            <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:24px 40px;text-align:center;">
              <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Best regards,</p>
              <p style="margin:0;font-size:14px;font-weight:700;color:#008060;">The COD King Team</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function btn(label: string, href: string, bg = "#008060") {
  return `<table cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
    <tr>
      <td style="border-radius:8px;background:${bg};">
        <a href="${href}" style="display:inline-block;padding:13px 28px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;letter-spacing:0.2px;">${label}</a>
      </td>
    </tr>
  </table>`;
}

// ─── 1. Welcome email ─────────────────────────────────────────────────────────

export async function sendWelcomeEmail({
  to,
  firstName,
  lastName,
}: {
  to: string;
  firstName: string;
  lastName: string;
}) {
  const fullName = `${firstName} ${lastName}`.trim() || "Merchant";

  const body = `
    <p style="margin:0 0 18px;font-size:16px;color:#1a1a1a;font-weight:600;">Hello ${fullName},</p>
    <p style="margin:0 0 16px;font-size:14px;color:#4b5563;line-height:1.7;">
      Thank you for signing up for <strong>COD King</strong>. We are thrilled to have you as a part of
      our community of merchants who are using COD King every day to ease their cash on delivery verifications.
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:#4b5563;line-height:1.7;">
      At COD King, we are committed to providing you with the best possible service. We would love to know
      more about your business and how we can customize COD King to suit your business needs. Our team is
      always here to help and provide you with the best possible service.
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#4b5563;line-height:1.7;">
      Go through our onboarding documentation to setup the app easily.
    </p>
    ${btn("Onboarding Documentation →", "https://help.codking.app/onboarding")}
    <p style="margin:24px 0 16px;font-size:14px;color:#4b5563;line-height:1.7;">
      Click the link below to chat with us instantly and let us know how we can help you:
    </p>
    ${btn("Chat with us now! 💬", CRISP_CHAT_URL, "#1a7a4a")}
    <p style="margin:8px 0 0;font-size:14px;color:#4b5563;">
      Thank you for choosing <strong>COD King</strong>. We look forward to serving you!
    </p>`;

  return resend.emails.send({
    from: FROM,
    to,
    subject: "Welcome to COD King!",
    html: emailShell("Welcome to COD King!", "#008060", "👑", body),
  });
}

// ─── 2. Farewell / uninstall email ───────────────────────────────────────────

export async function sendFarewellEmail({
  to,
  firstName,
  lastName,
}: {
  to: string;
  firstName: string;
  lastName: string;
}) {
  const fullName = `${firstName} ${lastName}`.trim() || "Merchant";

  const body = `
    <p style="margin:0 0 18px;font-size:16px;color:#1a1a1a;font-weight:600;">Hello ${fullName},</p>
    <p style="margin:0 0 16px;font-size:14px;color:#4b5563;line-height:1.7;">
      We're sad to hear that you're leaving. We understand that something didn't work as you needed,
      and we're sorry we couldn't deliver the experience you expected.
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:#4b5563;line-height:1.7;">
      We'd love a quick call or chat to understand what happened and how we could improve.
      Your feedback helps us make <strong>COD King</strong> better for everyone.
      If there's anything we can do to win you back, we're here for it.
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#4b5563;line-height:1.7;">
      Need help with anything — or just want to talk? Our team is one click away.
    </p>
    ${btn("Chat with us now! 💬", CRISP_CHAT_URL, "#b45309")}
    <p style="margin:24px 0 0;font-size:14px;color:#4b5563;line-height:1.7;">
      We hope to hear from you and get another chance to serve you better.
    </p>`;

  return resend.emails.send({
    from: FROM,
    to,
    subject: "We're sorry to see you go — COD King",
    html: emailShell("We're Sorry to See You Go", "#b45309", "😔", body),
  });
}

// ─── 3. Plan upgrade email ───────────────────────────────────────────────────

const PLAN_FEATURES: Record<string, string[]> = {
  starter: [
    "500 COD orders / month",
    "Auto-tagging of risky orders in Shopify",
    "All 8 risk signals",
    "Auto RTO detection",
  ],
  growth: [
    "2,000 COD orders / month",
    "Auto-cancel high-risk orders",
    "Pincode RTO analytics",
    "Everything in Starter",
  ],
  scale: [
    "Unlimited COD orders",
    "Priority support",
    "Custom signal weights",
    "Everything in Growth",
  ],
};

export async function sendPlanUpgradeEmail({
  to,
  firstName,
  lastName,
  plan,
  price,
}: {
  to: string;
  firstName: string;
  lastName: string;
  plan: string;
  price: number;
}) {
  const fullName = `${firstName} ${lastName}`.trim() || "Merchant";
  const planName = plan.charAt(0).toUpperCase() + plan.slice(1);
  const features = PLAN_FEATURES[plan] ?? [];

  const featureRows = features
    .map(
      (f) =>
        `<li style="font-size:13px;color:#3d4147;margin-bottom:6px;display:flex;align-items:flex-start;gap:8px;">
          <span style="color:#008060;font-weight:800;flex-shrink:0;">✓</span> ${f}
        </li>`
    )
    .join("");

  const body = `
    <p style="margin:0 0 18px;font-size:16px;color:#1a1a1a;font-weight:600;">Hello ${fullName},</p>
    <p style="margin:0 0 16px;font-size:14px;color:#4b5563;line-height:1.7;">
      You're now on the <strong>${planName} Plan</strong> — thank you for upgrading! 🎉
      Your store is now protected with more power and higher order limits.
    </p>

    <div style="background:#f4fff8;border:1px solid #d3f5e5;border-radius:10px;padding:20px 24px;margin-bottom:24px;">
      <div style="font-size:22px;font-weight:900;color:#008060;margin-bottom:4px;">${planName} Plan — $${price}/mo</div>
      <ul style="margin:12px 0 0;padding:0;list-style:none;">
        ${featureRows}
      </ul>
    </div>

    <p style="margin:0 0 20px;font-size:14px;color:#4b5563;line-height:1.7;">
      Head to your dashboard to see your upgraded limits in action, or reach out if you have any questions.
    </p>
    ${btn("Go to Dashboard →", "https://admin.shopify.com")}
    ${btn("Chat with us 💬", CRISP_CHAT_URL, "#1a7a4a")}
    <p style="margin:8px 0 0;font-size:14px;color:#4b5563;">
      Thank you for trusting <strong>COD King</strong> to protect your store!
    </p>`;

  return resend.emails.send({
    from: FROM,
    to,
    subject: `You're on ${planName}! 🎉 — COD King`,
    html: emailShell(`You're now on the ${planName} Plan!`, "#008060", "🚀", body),
  });
}
