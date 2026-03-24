/**
 * HomeKit Event Watcher
 *
 * Listens to Itsyhome SSE events and monitors automation sequences.
 * If expected follow-up actions don't happen within a timeout, alerts
 * the user via Discord and attempts to fix the issue.
 *
 * Monitored sequences:
 *   1. Night switch ON → 2 min → Security should be set to "Stay" (Home)
 *   2. Away switch ON  → 2 min → Security should be set to "Away"
 */

import http from 'http';
import { logger } from './logger.js';

const ITSYHOME_PORT = 8423;
const ITSYHOME_HOST = 'localhost';
const AUTOMATION_TIMEOUT_MS = 2.5 * 60 * 1000; // 2.5 minutes (give automations a buffer)
const RECONNECT_DELAY_MS = 5000;

interface PendingAutomation {
  trigger: string;
  expectedDevice: string;
  expectedCharacteristic: string;
  expectedSecurityTargetState?: number;
  timer: ReturnType<typeof setTimeout>;
  triggeredAt: number;
}

export function startHomekitWatcher(
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
) {
  const pending = new Map<string, PendingAutomation>();

  function connect() {
    logger.info('HomeKit watcher: connecting to Itsyhome SSE...');

    const req = http.get(
      `http://${ITSYHOME_HOST}:${ITSYHOME_PORT}/events`,
      { headers: { Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) {
          logger.warn(
            { statusCode: res.statusCode },
            'HomeKit watcher: unexpected status from SSE',
          );
          setTimeout(connect, RECONNECT_DELAY_MS);
          return;
        }

        logger.info('HomeKit watcher: connected to SSE stream');

        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6));
              handleEvent(event);
            } catch {
              // ignore malformed events
            }
          }
        });

        res.on('end', () => {
          logger.warn('HomeKit watcher: SSE stream ended, reconnecting...');
          setTimeout(connect, RECONNECT_DELAY_MS);
        });

        res.on('error', (err) => {
          logger.error(
            { err: err.message },
            'HomeKit watcher: SSE stream error',
          );
          setTimeout(connect, RECONNECT_DELAY_MS);
        });
      },
    );

    req.on('error', (err) => {
      logger.warn(
        { err: err.message },
        'HomeKit watcher: connection failed, retrying...',
      );
      setTimeout(connect, RECONNECT_DELAY_MS);
    });
  }

  function handleEvent(event: {
    device?: string;
    room?: string;
    characteristic?: string;
    value?: unknown;
    type?: string;
  }) {
    const { device, room, characteristic, value } = event;

    // --- Trigger: Night switch turned ON ---
    if (
      room === 'Security' &&
      device === 'Night' &&
      characteristic === 'power' &&
      value === true
    ) {
      logger.info(
        'HomeKit watcher: Night switch activated, expecting Stay arm in 2.5 min',
      );
      startPendingAutomation('night-to-stay', {
        trigger: 'Night switch ON',
        expectedDevice: 'DSC',
        expectedCharacteristic: 'securitySystemTargetState',
        expectedSecurityTargetState: 0, // Stay / Home
        timer: setTimeout(
          () => onAutomationFailed('night-to-stay'),
          AUTOMATION_TIMEOUT_MS,
        ),
        triggeredAt: Date.now(),
      });
    }

    // --- Trigger: Away switch turned ON ---
    if (
      room === 'Security' &&
      device === 'Away' &&
      characteristic === 'power' &&
      value === true
    ) {
      logger.info(
        'HomeKit watcher: Away switch activated, expecting Away arm in 2.5 min',
      );
      startPendingAutomation('away-to-armed', {
        trigger: 'Away switch ON',
        expectedDevice: 'DSC',
        expectedCharacteristic: 'securitySystemTargetState',
        expectedSecurityTargetState: 1, // Away
        timer: setTimeout(
          () => onAutomationFailed('away-to-armed'),
          AUTOMATION_TIMEOUT_MS,
        ),
        triggeredAt: Date.now(),
      });
    }

    // --- Resolution: Security system state changed ---
    // The DSC security system reports state changes via securitySystemTargetState
    // or securitySystemCurrentState. Any security state change on "DSC" device
    // after a trigger means the automation succeeded.
    if (
      room === 'Security' &&
      device === 'DSC' &&
      (characteristic === 'securitySystemTargetState' ||
        characteristic === 'securitySystemCurrentState')
    ) {
      if (pending.has('night-to-stay')) {
        logger.info(
          { value },
          'HomeKit watcher: Security state changed after Night trigger — automation succeeded',
        );
        clearPending('night-to-stay');
      }
      if (pending.has('away-to-armed')) {
        logger.info(
          { value },
          'HomeKit watcher: Security state changed after Away trigger — automation succeeded',
        );
        clearPending('away-to-armed');
      }
    }
  }

  function startPendingAutomation(key: string, automation: PendingAutomation) {
    // Clear any existing pending automation with this key
    clearPending(key);
    pending.set(key, automation);
  }

  function clearPending(key: string) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
    }
  }

  async function onAutomationFailed(key: string) {
    const automation = pending.get(key);
    if (!automation) return;
    pending.delete(key);

    const elapsed = Math.round((Date.now() - automation.triggeredAt) / 1000);

    // Before alerting, verify the actual DSC state from Itsyhome.
    // SSE events may be delayed/missed even if the alarm changed correctly.
    if (automation.expectedSecurityTargetState !== undefined) {
      try {
        const actual = await getSecuritySystemState();
        const currentMatches =
          actual.currentState === automation.expectedSecurityTargetState;
        const targetMatches =
          actual.targetState === automation.expectedSecurityTargetState;
        if (currentMatches || targetMatches) {
          logger.info(
            {
              key,
              trigger: automation.trigger,
              elapsed,
              actual,
              expected: automation.expectedSecurityTargetState,
            },
            'HomeKit watcher: suppressing false alarm — security system already in expected state',
          );
          return;
        }
      } catch (err) {
        logger.warn(
          { err, key },
          'HomeKit watcher: failed to verify actual DSC state before alerting',
        );
      }
    }

    logger.error(
      { key, trigger: automation.trigger, elapsed },
      'HomeKit watcher: automation failed',
    );

    // Notify user
    const message =
      `⚠️ **Home Automation Failed**\n` +
      `Trigger: **${automation.trigger}** (${elapsed}s ago)\n` +
      `Expected the security system to update, but it didn't.\n` +
      `Attempting to fix...`;

    try {
      await sendMessage(ownerJid, message);
    } catch (err) {
      logger.error({ err }, 'HomeKit watcher: failed to send alert');
    }

    // Auto-fix using the security-system service ID directly
    // (bypasses the name ambiguity between the switch and security-system services)
    const SECURITY_SYSTEM_SERVICE_ID = '53D95070-5CA7-502A-AC46-7C67DFB6ED4B';
    try {
      let fixAction: string;
      let armPath: string;
      if (key === 'night-to-stay') {
        fixAction = 'Arming security system to Stay';
        armPath = `/arm/stay/${SECURITY_SYSTEM_SERVICE_ID}`;
      } else if (key === 'away-to-armed') {
        fixAction = 'Arming security system to Away';
        armPath = `/arm/away/${SECURITY_SYSTEM_SERVICE_ID}`;
      } else {
        await sendMessage(ownerJid, `❌ Unknown automation key: ${key}`).catch(
          () => {},
        );
        return;
      }

      await itsyhomeRequest(armPath);
      await sendMessage(
        ownerJid,
        `🔧 ${fixAction} — command sent successfully.`,
      );
      logger.info({ key, fixAction, armPath }, 'HomeKit watcher: fix applied');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await sendMessage(ownerJid, `❌ Failed to auto-fix: ${errMsg}`).catch(
        () => {},
      );
      logger.error({ err: errMsg, key }, 'HomeKit watcher: fix failed');
    }
  }

  async function getSecuritySystemState(): Promise<{
    currentState: number | null;
    targetState: number | null;
  }> {
    const raw = await itsyhomeRequest('/debug/raw');
    const data = JSON.parse(raw) as {
      accessories?: Array<{
        room?: string;
        name?: string;
        services?: Array<{
          type?: string;
          id?: string;
          characteristics?: Array<{ type?: string; value?: unknown }>;
        }>;
      }>;
    };

    const securityAccessory = (data.accessories || []).find(
      (a) => a.room === 'Security' && a.name === 'DSC',
    );
    const securityService = (securityAccessory?.services || []).find(
      (s) =>
        s.id === '53D95070-5CA7-502A-AC46-7C67DFB6ED4B' ||
        s.type === '0000007E-0000-1000-8000-0026BB765291',
    );

    const currentState = (securityService?.characteristics || []).find(
      (c) => c.type === '00000066-0000-1000-8000-0026BB765291',
    )?.value;
    const targetState = (securityService?.characteristics || []).find(
      (c) => c.type === '00000067-0000-1000-8000-0026BB765291',
    )?.value;

    return {
      currentState: typeof currentState === 'number' ? currentState : null,
      targetState: typeof targetState === 'number' ? targetState : null,
    };
  }

  function itsyhomeRequest(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://${ITSYHOME_HOST}:${ITSYHOME_PORT}${path}`,
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            if (res.statusCode === 200) {
              resolve(data);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          });
        },
      );
      req.on('error', reject);
    });
  }

  connect();
  logger.info('HomeKit watcher: started');
}
