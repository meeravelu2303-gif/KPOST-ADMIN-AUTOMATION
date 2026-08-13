import fs from 'fs';
import net from 'net';
import tls from 'tls';
import path from 'path';
import dotenv from 'dotenv';
import type { RunModel } from './run-model';
import { EXECUTIVE_FILENAME, ROOT, resolveLatestRun } from './run-paths';

dotenv.config({ path: path.resolve(ROOT, '.env'), quiet: true });

/**
 * Developer email dispatcher.
 *
 * Mails the executive summary to the team after a run: an HTML digest in the body, and the
 * self-contained report attached so it opens offline from the mail client.
 *
 * The SMTP client below is deliberately hand-rolled rather than pulling in a mail library.
 * It speaks the subset the job needs — implicit TLS or STARTTLS, AUTH LOGIN or AUTH PLAIN,
 * one multipart message — and adds no third-party code to a repository whose whole purpose is
 * auditing someone else's security. If you later need DKIM, OAuth2 or connection pooling,
 * replace `sendMail` with a nodemailer transport; nothing above it changes.
 *
 * Every failure is reported and swallowed: a test run must never be marked broken because a
 * mail server was unreachable.
 */

const LOG = '[KPOST Reporter]';

export interface EmailConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  recipients: string[];
  /** Implicit TLS from the first byte. Defaults to true on 465, STARTTLS otherwise. */
  secure: boolean;
}

/**
 * Reads the SMTP settings, or explains precisely which one is missing. Returning the reason
 * rather than throwing is what lets the reporter print one clean skip line and move on.
 */
export function readEmailConfig(): { config: EmailConfig } | { skip: string } {
  const host = process.env.SMTP_HOST;
  if (!host) return { skip: 'SMTP_HOST not configured' };

  const recipients = (process.env.DEV_EMAIL_RECIPIENTS ?? '')
    .split(/[,;]/)
    .map((address) => address.trim())
    .filter(Boolean);
  if (recipients.length === 0) return { skip: 'DEV_EMAIL_RECIPIENTS not configured' };

  const port = Number(process.env.SMTP_PORT ?? 587);
  if (!Number.isFinite(port)) return { skip: `SMTP_PORT is not numeric ("${process.env.SMTP_PORT}")` };

  const user = process.env.SMTP_USER;
  const from = process.env.SMTP_FROM ?? user ?? `kpost-testbench@${host}`;
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === 'true' || process.env.SMTP_SECURE === '1'
    : port === 465;

  return { config: { host, port, user, pass: process.env.SMTP_PASS, from, recipients, secure } };
}

/* ------------------------------------------------------------------ message body */

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function passRate(model: RunModel): number {
  return model.totals.total
    ? Math.round((model.totals.passed / model.totals.total) * 1000) / 10
    : 0;
}

/**
 * The digest is styled with inline attributes and table layout on purpose: mail clients strip
 * <style> blocks and ignore flex/grid, so anything cleverer degrades to unstyled text.
 */
export function buildEmailHtml(model: RunModel): string {
  const rate = passRate(model);
  const verdictColour = model.totals.failed > 0 ? '#B3261E' : '#0F5C3F';

  const stat = (label: string, value: string, colour: string) =>
    `<td align="center" style="padding:12px 16px;border:1px solid #E2E7EE;border-radius:6px">` +
    `<div style="font:700 24px/1.1 Arial,sans-serif;color:${colour}">${escapeHtml(value)}</div>` +
    `<div style="font:11px/1.4 Arial,sans-serif;color:#7C8A9A;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(label)}</div></td>`;

  const bugRows = model.defects.length
    ? model.defects
        .map(
          (defect) =>
            `<tr>` +
            `<td style="padding:7px 10px;border-bottom:1px solid #E2E7EE;font:700 13px/1.4 Consolas,monospace">${escapeHtml(defect.id)}</td>` +
            `<td style="padding:7px 10px;border-bottom:1px solid #E2E7EE;font:13px/1.4 Arial,sans-serif">${escapeHtml(defect.severity)}</td>` +
            `<td style="padding:7px 10px;border-bottom:1px solid #E2E7EE;font:12px/1.4 Consolas,monospace">${escapeHtml(defect.method)} ${escapeHtml(defect.path)}</td>` +
            `<td style="padding:7px 10px;border-bottom:1px solid #E2E7EE;font:13px/1.4 Arial,sans-serif">${escapeHtml(defect.title)}</td>` +
            `<td style="padding:7px 10px;border-bottom:1px solid #E2E7EE;font:13px/1.4 Arial,sans-serif;color:#566577">${escapeHtml(defect.owner)}</td>` +
            `</tr>`
        )
        .join('')
    : `<tr><td colspan="5" style="padding:14px;font:13px/1.4 Arial,sans-serif;color:#7C8A9A">No defect was filed in this run.</td></tr>`;

  return `<!doctype html><html><body style="margin:0;background:#F4F6F9;padding:24px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:760px;margin:0 auto;background:#FFFFFF;border:1px solid #E2E7EE;border-radius:8px">
  <tr><td style="background:#112742;padding:22px 24px;border-radius:8px 8px 0 0">
    <div style="font:700 19px/1.2 Arial,sans-serif;color:#FFFFFF">KPOST — API Bug Report</div>
    <div style="font:13px/1.5 Arial,sans-serif;color:#9FB6D0;padding-top:4px">
      ${escapeHtml(model.environment.name)} · ${escapeHtml(model.environment.server)} · ${escapeHtml(model.generatedAtLabel)}
    </div>
  </td></tr>
  <tr><td style="padding:20px 24px 4px">
    <table role="presentation" cellpadding="0" cellspacing="6" width="100%"><tr>
      ${stat('Total tests', String(model.totals.total), '#14202E')}
      ${stat('Passed', String(model.totals.passed), '#0F5C3F')}
      ${stat('Failed', String(model.totals.failed), '#B3261E')}
      ${stat('Pass rate', `${rate}%`, verdictColour)}
      ${stat('Defects', String(model.defects.length), '#C98214')}
    </tr></table>
  </td></tr>
  <tr><td style="padding:16px 24px 0;font:600 13px/1.4 Arial,sans-serif;color:#14202E">Logged bugs</td></tr>
  <tr><td style="padding:8px 24px 20px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E2E7EE;border-radius:6px">
      <tr style="background:#F7F9FB">
        <th align="left" style="padding:8px 10px;font:600 10px/1.4 Arial,sans-serif;color:#7C8A9A;letter-spacing:.1em">BUG ID</th>
        <th align="left" style="padding:8px 10px;font:600 10px/1.4 Arial,sans-serif;color:#7C8A9A;letter-spacing:.1em">SEVERITY</th>
        <th align="left" style="padding:8px 10px;font:600 10px/1.4 Arial,sans-serif;color:#7C8A9A;letter-spacing:.1em">ENDPOINT</th>
        <th align="left" style="padding:8px 10px;font:600 10px/1.4 Arial,sans-serif;color:#7C8A9A;letter-spacing:.1em">TITLE</th>
        <th align="left" style="padding:8px 10px;font:600 10px/1.4 Arial,sans-serif;color:#7C8A9A;letter-spacing:.1em">OWNER</th>
      </tr>
      ${bugRows}
    </table>
  </td></tr>
  <tr><td style="padding:0 24px 22px;font:13px/1.6 Arial,sans-serif;color:#566577">
    The full interactive report is attached as <b>${escapeHtml(EXECUTIVE_FILENAME)}</b> — open it in a browser for
    reproduction steps, payloads and the execution trace. Archived on the runner as
    <span style="font-family:Consolas,monospace">reports/runs/${escapeHtml(model.runId)}/</span>.
  </td></tr>
</table></body></html>`;
}

export function buildSubject(model: RunModel): string {
  const rate = passRate(model);
  const verdict = model.totals.failed > 0 ? `${model.totals.failed} FAILED` : 'all passed';
  return `[KPOST] ${model.environment.name} API run — ${verdict}, ${rate}% pass, ${model.defects.length} defects`;
}

/* ------------------------------------------------------------------ MIME */

function base64Lines(buffer: Buffer): string {
  // RFC 2045 caps encoded lines at 76 characters; some servers reject longer ones outright.
  return (buffer.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

export function buildMimeMessage(options: {
  from: string;
  recipients: string[];
  subject: string;
  html: string;
  attachment?: { filename: string; content: Buffer };
  date: Date;
}): string {
  const boundary = `kpost-${options.date.getTime().toString(36)}-boundary`;
  const headers = [
    `From: KPOST Test Bench <${options.from}>`,
    `To: ${options.recipients.join(', ')}`,
    // The subject is ASCII by construction, so no RFC 2047 encoding is needed.
    `Subject: ${options.subject.replace(/[\r\n]+/g, ' ')}`,
    `Date: ${options.date.toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];

  const parts = [
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(options.html, 'utf-8')),
  ];

  if (options.attachment) {
    parts.push(
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8; name="${options.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${options.attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(options.attachment.content)
    );
  }

  parts.push(`--${boundary}--`, '');

  // Everything is base64, so no line can begin with "." and dot-stuffing is unnecessary.
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

/* ------------------------------------------------------------------ SMTP */

interface Conversation {
  send(command: string, expect: number[]): Promise<string>;
  end(): void;
}

const SOCKET_TIMEOUT_MS = 20_000;

/**
 * Wraps a socket in a request/response conversation. SMTP replies can span several lines;
 * a reply is complete when a line has a space (not a hyphen) after its three-digit code.
 */
function converse(socket: net.Socket): Conversation & { greeting: Promise<string> } {
  let buffer = '';
  let pending: { resolve: (value: string) => void; reject: (error: Error) => void; expect: number[] } | null = null;

  const settle = (): void => {
    if (!pending) return;
    const match = /^(\d{3}) [^\r\n]*\r\n$/m.exec(buffer.slice(buffer.lastIndexOf('\n', buffer.length - 2) + 1));
    if (!match) return;
    const code = Number(match[1]);
    const reply = buffer;
    buffer = '';
    const waiter = pending;
    pending = null;
    if (waiter.expect.length && !waiter.expect.includes(code)) {
      waiter.reject(new Error(`SMTP replied ${code}: ${reply.trim()}`));
    } else {
      waiter.resolve(reply);
    }
  };

  socket.setEncoding('utf-8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    settle();
  });

  const await_ = (expect: number[]): Promise<string> =>
    new Promise((resolve, reject) => {
      pending = { resolve, reject, expect };
      settle();
    });

  const greeting = await_([220]);

  return {
    greeting,
    send(command: string, expect: number[]): Promise<string> {
      const promise = await_(expect);
      socket.write(`${command}\r\n`);
      return promise;
    },
    end(): void {
      try {
        socket.write('QUIT\r\n');
      } catch {
        // Already closed; nothing to unwind.
      }
      socket.destroy();
    },
  };
}

function connect(config: EmailConfig): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host })
      : net.connect({ host: config.host, port: config.port });
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`timed out connecting to ${config.host}:${config.port}`));
    });
    socket.once('error', reject);
    socket.once(config.secure ? 'secureConnect' : 'connect', () => resolve(socket));
  });
}

function upgrade(socket: net.Socket, host: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername: host });
    secured.setTimeout(SOCKET_TIMEOUT_MS);
    secured.once('error', reject);
    secured.once('secureConnect', () => resolve(secured));
  });
}

/** Delivers one message. Resolves on a 250 for the DATA terminator, rejects on anything else. */
export async function sendMail(config: EmailConfig, message: string): Promise<void> {
  let socket = await connect(config);
  let chat = converse(socket);
  await chat.greeting;

  const ehlo = await chat.send(`EHLO ${config.host}`, [250]);

  if (!config.secure && /STARTTLS/i.test(ehlo)) {
    await chat.send('STARTTLS', [220]);
    socket = await upgrade(socket, config.host);
    chat = converse(socket);
    // The upgraded connection starts a fresh session, so the greeting is not repeated.
    await chat.send(`EHLO ${config.host}`, [250]);
  }

  if (config.user && config.pass) {
    if (/AUTH[ =-][^\r\n]*PLAIN/i.test(ehlo)) {
      const token = Buffer.from(`\0${config.user}\0${config.pass}`, 'utf-8').toString('base64');
      await chat.send(`AUTH PLAIN ${token}`, [235]);
    } else {
      await chat.send('AUTH LOGIN', [334]);
      await chat.send(Buffer.from(config.user, 'utf-8').toString('base64'), [334]);
      await chat.send(Buffer.from(config.pass, 'utf-8').toString('base64'), [235]);
    }
  }

  await chat.send(`MAIL FROM:<${config.from}>`, [250]);
  for (const recipient of config.recipients) {
    await chat.send(`RCPT TO:<${recipient}>`, [250, 251]);
  }
  await chat.send('DATA', [354]);
  await chat.send(`${message}\r\n.`, [250]);
  chat.end();
}

/* ------------------------------------------------------------------ entry point */

export interface DispatchResult {
  sent: boolean;
  detail: string;
}

/**
 * Sends the report for a run. `model` and `htmlPath` are supplied by the reporter; called
 * standalone, both are resolved from the latest run folder.
 */
export async function sendEmailReport(input?: {
  model: RunModel;
  htmlPath: string;
}): Promise<DispatchResult> {
  const settings = readEmailConfig();
  if ('skip' in settings) {
    const detail = `Email dispatch skipped - ${settings.skip}`;
    console.log(`${LOG} ${detail}`);
    return { sent: false, detail };
  }

  let model = input?.model;
  let htmlPath = input?.htmlPath;
  if (!model || !htmlPath) {
    const latest = resolveLatestRun();
    if (!latest) {
      const detail = 'Email dispatch skipped - no run found under reports/runs/';
      console.log(`${LOG} ${detail}`);
      return { sent: false, detail };
    }
    model = JSON.parse(fs.readFileSync(latest.runModel, 'utf-8')) as RunModel;
    htmlPath = latest.executiveHtml;
  }

  let attachment: { filename: string; content: Buffer } | undefined;
  try {
    attachment = { filename: EXECUTIVE_FILENAME, content: fs.readFileSync(htmlPath) };
  } catch {
    // Send the digest anyway: the numbers are the time-critical part, the attachment is not.
    console.log(`${LOG} Email attachment unavailable at ${htmlPath} - sending summary only`);
  }

  const message = buildMimeMessage({
    from: settings.config.from,
    recipients: settings.config.recipients,
    subject: buildSubject(model),
    html: buildEmailHtml(model),
    attachment,
    date: new Date(model.generatedAt),
  });

  try {
    await sendMail(settings.config, message);
    const detail = `Email sent to ${settings.config.recipients.length} recipient(s) via ${settings.config.host}:${settings.config.port}`;
    console.log(`${LOG} ${detail}`);
    return { sent: true, detail };
  } catch (error) {
    const detail = `Email dispatch failed - ${error instanceof Error ? error.message : String(error)}`;
    console.log(`${LOG} ${detail}`);
    return { sent: false, detail };
  }
}

if (require.main === module) {
  void sendEmailReport().then((result) => {
    process.exitCode = result.sent ? 0 : 0; // Never fail a pipeline over a notification.
  });
}
