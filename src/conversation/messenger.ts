import { loadMessenger, loadMessengerModule, type DoctorLine, type Messenger, type MessengerConfig } from "@ted-assistant/messenger";
import type { SignalOptions } from "@ted-assistant/signal/messenger";
import { settings } from "../core/settings.ts";
import { copyTruncateIfOver } from "../core/rotate.ts";
import { join } from "node:path";
import { dataPath, LOG_MAX_BYTES, openLog } from "../core/state.ts";
import { logPaths } from "../core/convpaths.ts";

// The one place the app meets its chat platform: which one (MESSENGER, default signal), how it is configured, and the instance in use.
// Everything else asks the messenger (packages/messenger); the platform package (packages/signal) is loaded by name and nothing here
// knows what a platform call looks like.

// Settings of the chosen platform, read from the environment by settings.ts and handed over as options (the interface calls them `unknown`; the platform package checks
// them when it makes the messenger). Signal's: where its daemon listens and where it saves attachments.
const options = (): SignalOptions => ({ host: settings.signalHost, port: settings.signalPort, attachmentsDir: settings.signalAttachmentsDir });

// The messenger of this run, made by main.ts. Modules that are built far from main (the voice tool reads attachments inside an MCP server)
// find it here.
let current: Messenger | undefined;
let cutting: NodeJS.Timeout | undefined;

/**
 * Loads the platform and remembers it as the one in use (not started yet: register the handlers first).
 * @param who `owner`: how the owner is addressed on the platform and her account id when known (the registry's, else the environment's); `account`: what the assistant runs as
 */
export async function loadMessengerInUse(who: { owner: MessengerConfig["owner"]; account: string }): Promise<Messenger> {
  current = await loadMessenger(settings.messenger, {
    ...who,
    options: options(),
    logger: console, // the app's console is the timestamped, redacting one from log.ts
    openLog: (file) => openLog(join(logPaths().dir, file)), // rotated here (rename) only when a daemon is started: a reused one keeps writing this same file

  });
  // A daemon (ours or a reused one) keeps signal-daemon.log open for days: check hourly and cut it by copy-truncate (its descriptor is O_APPEND).
  cutting ??= setInterval(() => copyTruncateIfOver(dataPath(logPaths().signalDaemon), LOG_MAX_BYTES, 2), 3_600_000).unref();
  return current;
}

/** The messenger in use. @throws before {@link loadMessengerInUse} */
export function messenger(): Messenger {
  if (!current) throw new Error("no messenger is running");
  return current;
}

/** The doctor's lines for the chosen platform, which need no running app: `account` is set when the assistant has an account of its own. */
export async function messengerDoctor(account: string | undefined): Promise<DoctorLine[]> {
  try {
    const module = await loadMessengerModule(settings.messenger);
    return [{ ok: true, what: "messenger", detail: settings.messenger }, ...(await module.doctor({ account, options: options() }))];
  } catch (e) {
    return [{ ok: false, what: "messenger", detail: (e as Error).message }];
  }
}
