---
name: itsyhome
description: Control smart home devices via Itsyhome (HomeKit bridge). Turn lights on/off, check device status, toggle devices, and control blinds. Use when the user asks about their home, lights, devices, or wants to control smart home accessories.
allowed-tools: Bash(curl:*)
---

# Itsyhome — Smart Home Control

Control HomeKit devices via the Itsyhome HTTP API running on the host.

## API Base URL

```
http://host.docker.internal:8423
```

## Commands

### Toggle a device on/off
```bash
curl -s http://host.docker.internal:8423/toggle/<Room>/<Device>
```

### Turn a device on
```bash
curl -s http://host.docker.internal:8423/on/<Room>/<Device>
```

### Turn a device off
```bash
curl -s http://host.docker.internal:8423/off/<Room>/<Device>
```

### Get device status
```bash
curl -s http://host.docker.internal:8423/debug/<Room> | python3 -m json.tool
```

### Get all devices (raw)
```bash
curl -s http://host.docker.internal:8423/debug/raw | python3 -c "
import json, sys
data = json.load(sys.stdin)
for a in data.get('accessories', []):
    room = a.get('room', '?')
    name = a.get('name', '?')
    reachable = a.get('reachable', False)
    print(f'{room}/{name} (reachable: {reachable})')
"
```

## URL Encoding

Device and room names with spaces must be URL-encoded:
- `Floor Lamp` → `Floor%20Lamp`
- `Front Door Lights` → `Front%20Door%20Lights`

## Available Rooms & Devices

| Room | Devices |
|------|---------|
| Basement | Basement Lights, Stairs, Water Valve, Basement Camera |
| Bedroom | Bedroom Lights |
| Entertainment | Living Room Apple TV |
| Garage | Garage Door, Garage Plug, Lights, Smart Wi-Fi Garage Door Opener |
| Kitchen | Kitchen, Kitchen Sliding Door, Side Door |
| Living Room | Christmas Tree, Living Room Lights, TV Backlight, Left, Middle, Right |
| Office | Elgato, Floor Lamp, Hue lightstrip, Left Desk, Right Desk |
| Outside | Front Door Lights, Front Roof Lights, Backyard, Backyard Roof, Driveway, Porch Lights |
| Security | Aqara Smart Lock, DSC (alarm panel), Away (switch), Night (switch) |

## Security / Alarm System

The DSC alarm panel (via Envisalink) is the **authoritative source** for the alarm state. It exposes a `SecuritySystem` service with these values:

| SecuritySystemCurrentState | Meaning |
|---|---|
| 0 | **Stay Armed** (Home) |
| 1 | **Away Armed** |
| 2 | **Night Armed** |
| 3 | **Disarmed** |
| 4 | **Alarm Triggered** |

To check the actual alarm state, look at the DSC accessory's `SecuritySystemCurrentState` value — **not** the Away/Night switches. The Away and Night switches are virtual switches used for automation triggers; their on/off state does NOT directly indicate the alarm mode.

**When reporting alarm status to the user:**
- Read `SecuritySystemCurrentState` from DSC → map to the table above
- Say "Stay Armed" / "Home" for value 0, "Away Armed" for 1, "Night Armed" for 2, "Disarmed" for 3

### Controlling the alarm (via service ID)

The DSC SecuritySystem service ID is `53D95070-5CA7-502A-AC46-7C67DFB6ED4B`.

```bash
# Arm Stay (Home)
curl -s http://host.docker.internal:8423/arm/stay/53D95070-5CA7-502A-AC46-7C67DFB6ED4B

# Arm Away
curl -s http://host.docker.internal:8423/arm/away/53D95070-5CA7-502A-AC46-7C67DFB6ED4B

# Disarm
curl -s http://host.docker.internal:8423/disarm/53D95070-5CA7-502A-AC46-7C67DFB6ED4B
```

## Security Rules

**IMPORTANT — Confirmation required for:**
- 🔒 Locks (Aqara Smart Lock) — ALWAYS ask user to confirm before locking/unlocking
- 🚪 Garage Door — ALWAYS ask user to confirm before opening/closing
- 🚨 Security modes (Away/Home/Night) — ALWAYS ask user to confirm before changing
- 💧 Water Valve — ALWAYS ask user to confirm before toggling

**No confirmation needed for:**
- 💡 Lights (any room)
- 🔌 Plugs
- 📺 TV/Entertainment
- 🪟 Blinds

## Examples

```bash
# Turn on office lights
curl -s http://host.docker.internal:8423/on/Office/Floor%20Lamp

# Turn off all outside lights
curl -s http://host.docker.internal:8423/off/Outside/Front%20Door%20Lights
curl -s http://host.docker.internal:8423/off/Outside/Porch%20Lights

# Check office status
curl -s http://host.docker.internal:8423/debug/Office | python3 -m json.tool
```
