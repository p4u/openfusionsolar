// SMTP delivery for alerts. Credentials come only from the environment and never leave this module.

const TIMEOUT_MS = 20e3; // nodemailer's defaults run to minutes and would stall the alert engine

// null without SMTP_HOST: alerts are then only listed in the app. nodemailer is loaded only when needed.
export async function createTransport(env) {
  if (!env.SMTP_HOST) return null;
  const { default: nodemailer } = await import('nodemailer');
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT) || undefined,
    secure: env.SMTP_SECURE === '1',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  const from = env.SMTP_FROM || env.SMTP_USER;
  return { send: ({ to, subject, text, html }) => transporter.sendMail({ from, to, subject, text, html }) };
}

// What the settings page may show about the transport (no user, no password).
export const smtpInfo = (env) => ({ host: env.SMTP_HOST || null, from: env.SMTP_FROM || null });
