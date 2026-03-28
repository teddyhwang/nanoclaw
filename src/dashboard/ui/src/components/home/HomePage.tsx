import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Lightbulb, Power, Thermometer,
  Lock, Unlock, Warehouse, Shield, ShieldCheck, ShieldOff, Droplets, Droplet, Gauge,
  RefreshCw, Blinds,
} from 'lucide-react';
import { Layout } from '../Layout';
import { Loading } from '../Loading';
import { PageContent, Panel } from '@/components/shared';
import styles from './HomePage.module.css';

// ── Types ────────────────────────────────────────────────────

interface Service {
  type: string;
  characteristics: Record<string, unknown>;
}

interface Device {
  name: string;
  reachable: boolean;
  services: Service[];
}

interface Room {
  devices: Device[];
}

interface HomeData {
  rooms: Record<string, Room>;
}

// ── Constants ────────────────────────────────────────────────

const ROOM_ORDER = [
  'Security', 'Living Room', 'Entertainment', 'Kitchen', 'Office', 'Bedroom',
  'Basement', 'Garage', 'Outside', 'Temperature',
];

const HUB_NAMES = new Set([
  'Homebridge', 'Home Assistant', 'Starling Home Hub',
  'RYSE SmartBridge', 'Aqara Hub M3', 'eufy HomeBase',
]);

const HIDDEN_DEVICES = new Set([
  'Fridge freezer',
]);

const HIDDEN_ROOMS = new Set([
  'Water Sensors', 'Riley', 'Cody', 'Kitchen', 'Entertainment',
]);

const HIDDEN_SERVICE_TYPES = new Set([
  'MotionSensor',
  'ContactSensor',
  'NowPlayingService',
  'Fan',
]);

const HUB_SERVICE_TYPES = new Set([
  'ProtocolInformation', 'AccessoryInformation', 'FirmwareUpdate',
  'WiFiTransport', 'AccessoryRuntimeInformation',
]);

// ── Helpers ──────────────────────────────────────────────────

function getChar(svc: Service, type: string): unknown | undefined {
  return svc.characteristics[type];
}

function isHubDevice(device: Device): boolean {
  if (HUB_NAMES.has(device.name)) return true;
  if (HIDDEN_DEVICES.has(device.name)) return true;
  return device.services.length > 0 && device.services.every(s => HUB_SERVICE_TYPES.has(s.type));
}

function getVisibleServices(device: Device): Service[] {
  const hasThermostat = device.services.some(s => s.type === 'Thermostat');
  return device.services.filter(s => {
    if (HUB_SERVICE_TYPES.has(s.type) || HIDDEN_SERVICE_TYPES.has(s.type)) return false;
    // Hide generic Switch on thermostat devices (auxiliary/hold switch)
    if (hasThermostat && s.type === 'Switch') return false;
    return true;
  });
}

function sortRooms(rooms: string[]): string[] {
  const ordered: string[] = [];
  const rest: string[] = [];
  for (const name of ROOM_ORDER) {
    if (rooms.includes(name)) ordered.push(name);
  }
  for (const name of rooms.sort()) {
    if (!ordered.includes(name)) rest.push(name);
  }
  return [...ordered, ...rest];
}

function getSecurityState(data: HomeData): { current: number; label: string; color: string; status: 'armed' | 'disarmed' | 'triggered' } | null {
  for (const room of Object.values(data.rooms)) {
    for (const device of room.devices) {
      for (const svc of device.services) {
        if (svc.type === 'SecuritySystem') {
          const current = getChar(svc, 'SecuritySystemCurrentState') as number | undefined;
          if (current === undefined) continue;
          switch (current) {
            case 0: return { current, label: 'Stay Armed', color: 'var(--green)', status: 'armed' };
            case 1: return { current, label: 'Away Armed', color: 'var(--green)', status: 'armed' };
            case 2: return { current, label: 'Night Armed', color: 'var(--green)', status: 'armed' };
            case 3: return { current, label: 'Disarmed', color: 'var(--yellow)', status: 'disarmed' };
            case 4: return { current, label: 'Alarm Triggered', color: 'var(--red)', status: 'triggered' };
            default: return { current, label: `State ${current}`, color: 'var(--muted)', status: 'disarmed' };
          }
        }
      }
    }
  }
  return null;
}

/** Get temperature for a room from its devices */
function getRoomTemp(devices: Device[]): number | undefined {
  for (const d of devices) {
    for (const s of d.services) {
      if (s.type === 'TemperatureSensor') {
        const t = getChar(s, 'CurrentTemperature') as number | undefined;
        if (t !== undefined) return t;
      }
      if (s.type === 'Thermostat') {
        const t = getChar(s, 'CurrentTemperature') as number | undefined;
        if (t !== undefined) return t;
      }
    }
  }
  return undefined;
}

function fmtC(c: number): string {
  return `${c.toFixed(1)}°C`;
}

// ── Security banner ──────────────────────────────────────────

interface SecurityBannerProps {
  security: { current: number; label: string; color: string; status: 'armed' | 'disarmed' | 'triggered' };
  onSetMode: (mode: string) => void;
  settingMode: string | null;
}

function SecurityModeButtons({ security, onSetMode, settingMode }: SecurityBannerProps) {
  const modes = [
    { key: 'stay', label: 'Home', stateVal: 0 },
    { key: 'away', label: 'Away', stateVal: 1 },
    { key: 'night', label: 'Night', stateVal: 2 },
    { key: 'disarm', label: 'Disarm', stateVal: 3 },
  ];

  return (
    <div className={styles.securitySection}>
      <div className={styles.securityStatus}>
        <div className={styles.securityIcon} style={{ color: security.color }}>
          {security.status === 'armed' ? <ShieldCheck size={18} /> :
           security.status === 'triggered' ? <Shield size={18} /> :
           <ShieldOff size={18} />}
        </div>
        <span className={styles.securityState} style={{ color: security.color }}>
          {security.label}
        </span>
        <div className={`${styles.statusDot} ${styles[security.status]}`} />
      </div>
      <div className={styles.securityModes}>
        {modes.map(m => {
          const isActive = security.current === m.stateVal;
          const isSetting = settingMode === m.key;
          return (
            <button
              key={m.key}
              className={`${styles.modeBtn}${isActive ? ` ${styles.modeActive}` : ''}${isSetting ? ` ${styles.modeSetting}` : ''}`}
              onClick={() => !isActive && onSetMode(m.key)}
              disabled={isActive || !!settingMode}
            >
              {isSetting ? <RefreshCw size={12} className={styles.spinning} /> : null}
              {m.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Lock control ─────────────────────────────────────────────

interface LockRowProps {
  device: Device;
  onLockAction: (action: 'lock' | 'unlock') => void;
  lockLoading: boolean;
}

function LockRow({ device, onLockAction, lockLoading }: LockRowProps) {
  const svc = device.services.find(s => s.type === 'LockMechanism');
  if (!svc) return null;
  const locked = getChar(svc, 'LockCurrentState') as number | undefined;
  const isLocked = locked === 1;
  const batterySvc = device.services.find(s => s.type === 'Battery');
  const battery = batterySvc ? getChar(batterySvc, 'BatteryLevel') as number | undefined : undefined;

  return (
    <div className={`${styles.deviceRow}${!device.reachable ? ` ${styles.unreachable}` : ''}`}>
      <div className={`${styles.deviceIcon}${isLocked ? ` ${styles.locked}` : ` ${styles.unlocked}`}`}>
        {isLocked ? <Lock size={16} /> : <Unlock size={16} />}
      </div>
      <span className={styles.deviceName}>
        {device.name}
        {battery !== undefined && <span className={styles.battery}>{battery}%</span>}
      </span>
      <span className={styles.deviceValue}>{isLocked ? 'Locked' : 'Unlocked'}</span>
      <button
        className={`${styles.toggleBtn}${!isLocked ? ` ${styles.lockWarn}` : ''}`}
        onClick={() => onLockAction(isLocked ? 'unlock' : 'lock')}
        disabled={lockLoading}
        title={isLocked ? 'Unlock' : 'Lock'}
      >
        {lockLoading
          ? <RefreshCw size={14} className={styles.spinning} />
          : isLocked ? <Unlock size={14} /> : <Lock size={14} />}
      </button>
    </div>
  );
}

// ── Device rendering ─────────────────────────────────────────

interface DeviceRowProps {
  device: Device;
  roomName: string;
  onToggle: (room: string, device: string) => void;
  onLockAction: (action: 'lock' | 'unlock') => void;
  lockLoading: boolean;
}

function DeviceRows({ device, roomName, onToggle, onLockAction, lockLoading }: DeviceRowProps) {
  const rows: JSX.Element[] = [];
  const visibleServices = getVisibleServices(device);

  for (const svc of visibleServices) {
    if (HUB_SERVICE_TYPES.has(svc.type)) continue;

    switch (svc.type) {
      case 'Lightbulb': {
        const on = !!getChar(svc, 'On');
        const brightness = getChar(svc, 'Brightness') as number | undefined;
        rows.push(
          <div key={`${device.name}-light`} className={`${styles.deviceRow}${!device.reachable ? ` ${styles.unreachable}` : ''}`}>
            <div className={`${styles.deviceIcon}${on ? ` ${styles.active}` : ''}`}>
              <Lightbulb size={16} />
            </div>
            <span className={styles.deviceName}>{device.name}</span>
            {on && brightness !== undefined && (
              <span className={styles.deviceValue}>{brightness}%</span>
            )}
            <button
              className={`${styles.toggleBtn}${on ? ` ${styles.on}` : ''}`}
              onClick={() => onToggle(roomName, device.name)}
              title={on ? 'Turn off' : 'Turn on'}
            >
              <Power size={14} />
            </button>
          </div>
        );
        break;
      }
      case 'Switch':
      case 'Outlet': {
        const on = !!getChar(svc, 'On');
        rows.push(
          <div key={`${device.name}-switch-${svc.type}`} className={`${styles.deviceRow}${!device.reachable ? ` ${styles.unreachable}` : ''}`}>
            <div className={`${styles.deviceIcon}${on ? ` ${styles.active}` : ''}`}>
              <Power size={16} />
            </div>
            <span className={styles.deviceName}>{device.name}</span>
            <button
              className={`${styles.toggleBtn}${on ? ` ${styles.on}` : ''}`}
              onClick={() => onToggle(roomName, device.name)}
              title={on ? 'Turn off' : 'Turn on'}
            >
              <Power size={14} />
            </button>
          </div>
        );
        break;
      }
      case 'ContactSensor':
        // Filtered out via HIDDEN_SERVICE_TYPES
        break;
      case 'TemperatureSensor': {
        // Shown as room subtitle, skip inline
        break;
      }
      case 'LockMechanism': {
        rows.push(
          <LockRow
            key={`${device.name}-lock`}
            device={device}
            onLockAction={onLockAction}
            lockLoading={lockLoading}
          />
        );
        break;
      }
      case 'GarageDoorOpener': {
        const state = getChar(svc, 'CurrentDoorState') as number | undefined;
        // 0=Open, 1=Closed, 2=Opening, 3=Closing, 4=Stopped
        const stateLabels: Record<number, string> = { 0: 'Open', 1: 'Closed', 2: 'Opening', 3: 'Closing', 4: 'Stopped' };
        const label = state !== undefined ? (stateLabels[state] ?? 'Unknown') : 'Unknown';
        const isOpen = state === 0 || state === 2;
        rows.push(
          <div key={`${device.name}-garage`} className={styles.deviceRow}>
            <div className={`${styles.deviceIcon}${isOpen ? ` ${styles.open}` : ''}`}>
              <Warehouse size={16} />
            </div>
            <span className={styles.deviceName}>{device.name}</span>
            <span className={styles.deviceValue}>{label}</span>
          </div>
        );
        break;
      }
      case 'WindowCovering': {
        const pos = getChar(svc, 'CurrentPosition') as number | undefined;
        rows.push(
          <div key={`${device.name}-blind`} className={styles.deviceRow}>
            <div className={styles.deviceIcon}>
              <Blinds size={16} />
            </div>
            <span className={styles.deviceName}>{device.name}</span>
            <span className={styles.deviceValue}>{pos !== undefined ? `${pos}%` : '—'}</span>
          </div>
        );
        break;
      }
      case 'NowPlayingService':
      case 'Fan':
        // Filtered
        break;
      case 'LeakSensor': {
        const leak = !!getChar(svc, 'LeakDetected');
        rows.push(
          <div key={`${device.name}-leak`} className={styles.deviceRow}>
            <div className={`${styles.deviceIcon}${leak ? ` ${styles.leak}` : ''}`}>
              <Droplets size={16} />
            </div>
            <span className={styles.deviceName}>{device.name}</span>
            <span className={styles.deviceValue}>{leak ? 'Leak!' : 'Dry'}</span>
          </div>
        );
        break;
      }
      case 'HumiditySensor': {
        const h = getChar(svc, 'CurrentRelativeHumidity') as number | undefined;
        if (h !== undefined) {
          rows.push(
            <div key={`${device.name}-humidity`} className={styles.deviceRow}>
              <div className={styles.deviceIcon}>
                <Droplet size={16} />
              </div>
              <span className={styles.deviceName}>{device.name}</span>
              <span className={styles.deviceValue}>{Math.round(h)}%</span>
            </div>
          );
        }
        break;
      }
      case 'Thermostat': {
        const target = getChar(svc, 'TargetTemperature') as number | undefined;
        if (target !== undefined) {
          rows.push(
            <div key={`${device.name}-thermostat`} className={styles.deviceRow}>
              <div className={styles.deviceIcon}>
                <Gauge size={16} />
              </div>
              <span className={styles.deviceName}>{device.name}</span>
              <span className={styles.deviceValue}>
                Target {fmtC(target)}
              </span>
            </div>
          );
        }
        break;
      }
      case 'SecuritySystem':
        // Shown in banner
        break;
      default:
        break;
    }
  }

  return <>{rows}</>;
}

// ── Main component ───────────────────────────────────────────

export function HomePage() {
  const [data, setData] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settingMode, setSettingMode] = useState<string | null>(null);
  const [lockLoading, setLockLoading] = useState(false);
  const prevDataRef = useRef<HomeData | null>(null);

  const fetchData = useCallback(async (silent = false) => {
    try {
      const res = await fetch('/api/home/devices');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      prevDataRef.current = json;
      setError(null);
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(() => fetchData(true), 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleToggle = useCallback(async (room: string, device: string) => {
    if (!data) return;
    const prev = structuredClone(data);
    const updated = structuredClone(data);
    const roomData = updated.rooms[room];
    if (roomData) {
      const dev = roomData.devices.find(d => d.name === device);
      if (dev) {
        for (const svc of dev.services) {
          if (svc.type === 'Lightbulb' || svc.type === 'Switch' || svc.type === 'Outlet') {
            if ('On' in svc.characteristics) {
              svc.characteristics['On'] = !svc.characteristics['On'];
            }
          }
        }
      }
    }
    setData(updated);
    try {
      const res = await fetch('/api/home/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room, device, action: 'toggle' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setData(prev);
    }
  }, [data]);

  const handleSetSecurityMode = useCallback(async (mode: string) => {
    setSettingMode(mode);
    try {
      const res = await fetch('/api/home/security/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Refresh data after a short delay to let the system update
      setTimeout(() => fetchData(true), 2000);
    } catch (e) {
      console.error('Failed to set security mode:', e);
    } finally {
      setSettingMode(null);
    }
  }, [fetchData]);

  const handleLockAction = useCallback(async (action: 'lock' | 'unlock') => {
    setLockLoading(true);
    try {
      const res = await fetch('/api/home/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTimeout(() => fetchData(true), 2000);
    } catch (e) {
      console.error('Failed to control lock:', e);
    } finally {
      setLockLoading(false);
    }
  }, [fetchData]);

  if (loading && !data) return <Loading message="Loading smart home…" />;
  if (error && !data) return <Loading error={error} />;
  if (!data) return <Loading error="No home data available" />;

  const security = getSecurityState(data);

  // Build room list, filtering hidden rooms and hub-only rooms
  const roomNames = sortRooms(
    Object.entries(data.rooms)
      .filter(([name, room]) => {
        if (HIDDEN_ROOMS.has(name)) return false;
        const meaningful = room.devices.filter(d => !isHubDevice(d));
        return meaningful.length > 0;
      })
      .map(([name]) => name)
  );

  return (
    <Layout>
      <PageContent>
        <div className={styles.sections}>
          {/* Room cards */}
          <div className={styles.roomGrid}>
            {roomNames.map(roomName => {
              const room = data.rooms[roomName];
              const devices = room.devices.filter(d => !isHubDevice(d));
              // Check if room has any visible non-security services
              const hasVisible = devices.some(d =>
                getVisibleServices(d).some(s =>
                  s.type !== 'SecuritySystem' && s.type !== 'TemperatureSensor'
                )
              );
              // Also show room if it has temperature (will be in subtitle)
              const roomTemp = getRoomTemp(devices);
              if (!hasVisible && roomTemp === undefined) return null;

              const isSecurityRoom = roomName === 'Security';

              return (
                <Panel
                  key={roomName}
                  title={roomName}
                  headerRight={
                    roomTemp !== undefined ? (
                      <span className={styles.roomTemp}>
                        <Thermometer size={14} />
                        {fmtC(roomTemp)}
                      </span>
                    ) : undefined
                  }
                >
                  {isSecurityRoom && security && (
                    <SecurityModeButtons
                      security={security}
                      onSetMode={handleSetSecurityMode}
                      settingMode={settingMode}
                    />
                  )}
                  <div className={styles.deviceList}>
                    {devices.map(device => (
                      <DeviceRows
                        key={device.name}
                        device={device}
                        roomName={roomName}
                        onToggle={handleToggle}
                        onLockAction={handleLockAction}
                        lockLoading={lockLoading}
                      />
                    ))}
                  </div>
                </Panel>
              );
            })}
          </div>
        </div>
      </PageContent>
    </Layout>
  );
}
