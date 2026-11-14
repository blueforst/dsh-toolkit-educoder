#!/usr/bin/env node
import { UsageError, redactText } from './lib/config.mjs';
import { runCli } from './lib/commands.mjs';

try {
  const code = await runCli(process.argv.slice(2), process.env);
  process.exitCode = code;
} catch (error) {
  const redactionConfig = {
    session: (() => {
      try {
        return process.env.DSH_EDUCODER_SESSION ? JSON.parse(process.env.DSH_EDUCODER_SESSION) : undefined;
      } catch {
        return undefined;
      }
    })(),
    signingAccessKey: process.env.DSH_EDUCODER_SIGNING_AK || process.env.EDUCODER_SIGNING_ACCESS_KEY,
    signingSecretKey: process.env.DSH_EDUCODER_SIGNING_SK || process.env.EDUCODER_SIGNING_SECRET_KEY,
  };
  const isKnownError = error instanceof UsageError || error?.name === 'TransportError' || typeof error?.code === 'string';
  const rawMessage = isKnownError ? (error?.message || String(error)) : (error?.stack || error?.message || String(error));
  const safeMessage = redactText(rawMessage, redactionConfig);
  const safeCode = isKnownError && typeof error?.code === 'string' && error.code ? `[${error.code}] ` : '';
  const safeDetail = error?.detail ? redactText(error.detail, redactionConfig) : '';
  process.stderr.write(`[educoder-cli error] ${safeCode}${safeMessage}${safeDetail ? ` (${safeDetail})` : ''}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
