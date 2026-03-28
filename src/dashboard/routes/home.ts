import type { FastifyInstance } from 'fastify';

const ITSYHOME_BASE = 'http://localhost:8423';

async function fetchItsyhome(endpoint: string): Promise<unknown> {
  const resp = await fetch(`${ITSYHOME_BASE}${endpoint}`);
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const SERVICE_TYPES: Record<string, string> = {
  '00000043': 'Lightbulb',
  '00000049': 'Switch',
  '00000045': 'LockMechanism',
  '00000041': 'GarageDoorOpener',
  '00000080': 'ContactSensor',
  '00000085': 'MotionSensor',
  '0000008A': 'TemperatureSensor',
  '00000082': 'HumiditySensor',
  '0000004A': 'Thermostat',
  '0000007E': 'SecuritySystem',
  '00000086': 'OccupancySensor',
  '00000083': 'LeakSensor',
  '0000008C': 'WindowCovering',
  '00000047': 'Outlet',
  '00000040': 'Fan',
  '000000D8': 'NowPlayingService',
};

const SKIP_SERVICES = new Set([
  '0000003E',
  '000000D9',
  '00000204',
  '0000021A',
  '00000112',
  '0000022A',
  '00000239',
  '00000236',
  '00000113',
]);

const CUSTOM_CHAR_TYPES: Record<string, string> = {
  '2A64B222': 'NowPlaying',
  '301323DC': 'PlaybackState',
  '3FDFF90C': 'MediaType',
  ABFC7776: 'Duration',
  '3E195A75': 'ElapsedTime',
  '000000E8': 'Active',
  '000000E3': 'ConfiguredName',
};

const CHAR_TYPES: Record<string, string> = {
  '00000025': 'On',
  '00000008': 'Brightness',
  '00000013': 'Hue',
  '0000002F': 'Saturation',
  '000000CE': 'ColorTemperature',
  '00000011': 'CurrentTemperature',
  '00000010': 'CurrentRelativeHumidity',
  '0000006A': 'ContactSensorState',
  '00000022': 'MotionDetected',
  '0000001D': 'LockCurrentState',
  '0000001E': 'LockTargetState',
  '00000066': 'SecuritySystemCurrentState',
  '00000067': 'SecuritySystemTargetState',
  '00000075': 'StatusActive',
  '00000079': 'StatusLowBattery',
  '00000068': 'BatteryLevel',
  '0000006F': 'OccupancyDetected',
  '00000070': 'LeakDetected',
  '0000006D': 'CurrentPosition',
  '0000007C': 'TargetPosition',
  '0000000D': 'CurrentHeatingCoolingState',
  '0000000F': 'TargetHeatingCoolingState',
  '00000012': 'TargetTemperature',
  '0000000E': 'CurrentDoorState',
  '00000032': 'TargetDoorState',
  '00000024': 'ObstructionDetected',
};

const SECURITY_STATES: Record<number, string> = {
  0: 'Stay Armed',
  1: 'Away Armed',
  2: 'Night Armed',
  3: 'Disarmed',
  4: 'Alarm Triggered',
};

const SECURITY_SERVICE_ID = '53D95070-5CA7-502A-AC46-7C67DFB6ED4B';

interface ParsedDevice {
  name: string;
  reachable: boolean;
  services: { type: string; characteristics: Record<string, unknown> }[];
}

function parseHomeDevices(raw: unknown): {
  rooms: Record<string, { devices: ParsedDevice[] }>;
} {
  const rooms: Record<string, { devices: ParsedDevice[] }> = {};
  const accessories =
    raw && typeof raw === 'object' && 'accessories' in raw
      ? (raw as { accessories: unknown[] }).accessories
      : raw;
  if (!Array.isArray(accessories)) return { rooms };

  for (const accessory of accessories) {
    const room = accessory.room || 'Default Room';
    const name = accessory.name || 'Unknown';
    const reachable = accessory.reachable !== false;

    const services: {
      type: string;
      characteristics: Record<string, unknown>;
    }[] = [];

    if (Array.isArray(accessory.services)) {
      for (const svc of accessory.services) {
        const svcTypeKey = (svc.type || '').substring(0, 8).toUpperCase();
        if (SKIP_SERVICES.has(svcTypeKey)) continue;
        const svcName = SERVICE_TYPES[svcTypeKey];
        if (!svcName) continue;

        const characteristics: Record<string, unknown> = {};
        if (Array.isArray(svc.characteristics)) {
          for (const ch of svc.characteristics) {
            const charTypeKey = (ch.type || '').substring(0, 8).toUpperCase();
            const charName =
              CHAR_TYPES[charTypeKey] || CUSTOM_CHAR_TYPES[charTypeKey];
            if (charName) {
              characteristics[charName] = ch.value;
            }
          }
        }

        if (Object.keys(characteristics).length > 0) {
          services.push({ type: svcName, characteristics });
        }
      }
    }

    if (services.length > 0) {
      if (!rooms[room]) rooms[room] = { devices: [] };
      rooms[room].devices.push({ name, reachable, services });
    }
  }

  return { rooms };
}

function parseSecurityState(raw: unknown): {
  currentState: number;
  targetState: number;
  stateName: string;
} {
  const fallback = { currentState: 3, targetState: 3, stateName: 'Disarmed' };
  const accessories =
    raw && typeof raw === 'object' && 'accessories' in raw
      ? (raw as { accessories: unknown[] }).accessories
      : raw;
  if (!Array.isArray(accessories)) return fallback;

  for (const accessory of accessories) {
    if (!Array.isArray(accessory.services)) continue;
    for (const svc of accessory.services) {
      const svcTypeKey = (svc.type || '').substring(0, 8).toUpperCase();
      if (svcTypeKey !== '0000007E') continue;

      let currentState = 3;
      let targetState = 3;
      if (Array.isArray(svc.characteristics)) {
        for (const ch of svc.characteristics) {
          const charKey = (ch.type || '').substring(0, 8).toUpperCase();
          if (charKey === '00000066') currentState = ch.value ?? 3;
          if (charKey === '00000067') targetState = ch.value ?? 3;
        }
      }
      return {
        currentState,
        targetState,
        stateName: SECURITY_STATES[currentState] || 'Unknown',
      };
    }
  }

  return fallback;
}

export default async function homeRoutes(fastify: FastifyInstance) {
  fastify.get('/api/home/devices', async () => {
    const raw = await fetchItsyhome('/debug/raw');
    return parseHomeDevices(raw);
  });

  fastify.post('/api/home/control', async (request, reply) => {
    const { room, device, action } = request.body as {
      room?: string;
      device?: string;
      action?: string;
    };
    if (!room || !device || !['on', 'off', 'toggle'].includes(action || '')) {
      return reply
        .code(400)
        .send({ error: 'Required: room, device, action (on|off|toggle)' });
    }
    const encodedRoom = encodeURIComponent(room);
    const encodedDevice = encodeURIComponent(device);
    return fetchItsyhome(`/${action}/${encodedRoom}/${encodedDevice}`);
  });

  fastify.get('/api/home/security', async () => {
    const raw = await fetchItsyhome('/debug/raw');
    return parseSecurityState(raw);
  });

  fastify.post('/api/home/security/set', async (request, reply) => {
    const { mode } = request.body as { mode?: string };
    if (mode === 'stay' || mode === 'away') {
      return fetchItsyhome(`/arm/${mode}/${SECURITY_SERVICE_ID}`);
    } else if (mode === 'night') {
      return fetchItsyhome(`/arm/night/${SECURITY_SERVICE_ID}`);
    } else if (mode === 'disarm') {
      return fetchItsyhome(`/disarm/${SECURITY_SERVICE_ID}`);
    }
    return reply
      .code(400)
      .send({ error: 'mode must be stay, away, night, or disarm' });
  });

  fastify.post('/api/home/lock', async (request, reply) => {
    const { action } = request.body as { action?: string };
    if (action === 'lock') {
      return fetchItsyhome('/on/Security/Aqara%20Smart%20Lock');
    } else if (action === 'unlock') {
      return fetchItsyhome('/off/Security/Aqara%20Smart%20Lock');
    }
    return reply.code(400).send({ error: 'action must be lock or unlock' });
  });
}
