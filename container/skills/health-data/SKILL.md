---
name: health-data
description: Query Apple Health data via the dashboard API. Use when the user asks about steps, weight, heart rate, workouts, sleep, VO2 max, activity rings, or any health/fitness metrics.
allowed-tools: Bash(curl:*)
---

# Health Data — Apple Health Dashboard API

Query Apple Health data via the dashboard API running on the host.

## API Base URL

```
http://host.docker.internal:3002
```

## ⚠️ CRITICAL: Discord Formatting Rules

**NEVER use markdown tables (pipe `|` syntax).** Discord does not render them — they appear as ugly raw text.

Format data as **bullet lists** or **line-per-item**:
```
This week's steps:

• Mon Mar 24 — 8,432 steps
• Tue Mar 25 — 12,105 steps
• Wed Mar 26 — 6,891 steps

**Average: 9,143 steps/day**
```

## Endpoint

```
GET /api/health?days=N
GET /api/health?since=YYYY-MM-DD
GET /api/health?since=YYYY-MM-DD&until=YYYY-MM-DD
```

Parameters (pick one date mode):
- `days` — number of days to look back (default: 90, max: 5500)
- `since` — start date (inclusive), format `YYYY-MM-DD`
- `until` — end date (inclusive), only used with `since`

## Response Shape

The API returns JSON with these fields:

```json
{
  "minDate": "2011-01-31",
  "steps": [{ "date": "2026-03-27", "steps": 8432 }],
  "restingHeartRate": [{ "date": "2026-03-27", "value": 52 }],
  "heartRateVariability": [{ "date": "2026-03-27", "value": 45.2 }],
  "weight": [{ "date": "2026-03-27", "value": 82.5 }],
  "bodyFat": [{ "date": "2026-03-27", "value": 18.2 }],
  "activityRings": [{
    "date": "2026-03-27",
    "moveActual": 650,
    "moveGoal": 600,
    "exerciseActual": 35,
    "exerciseGoal": 30,
    "standActual": 12,
    "standGoal": 12
  }],
  "workouts": [{
    "date": "2026-03-27",
    "type": "Running",
    "duration": 32.5,
    "distance": 5.22,
    "calories": 376,
    "avgHR": 143,
    "maxHR": 179
  }],
  "workoutTypeBreakdown": [{
    "type": "Running",
    "count": 12,
    "totalDuration": 384,
    "totalCalories": 4560
  }],
  "weeklyStepAverage": [{
    "week": "2026-03-24",
    "avgSteps": 9143
  }]
}
```

### Field notes

- `steps[].steps` — total steps for that day
- `weight[].value` — kilograms (multiply by 2.20462 for lbs)
- `activityRings[]` — `moveActual`/`moveGoal` (Cal), `exerciseActual`/`exerciseGoal` (min), `standActual`/`standGoal` (hours)
- `workouts[].duration` — minutes; `distance` — km; `calories` — kcal; `avgHR`/`maxHR` — bpm
- `workoutTypeBreakdown[].totalDuration` — total minutes for that workout type
- Data goes back to **2011**

### Workout types available

Basketball, Climbing, Flexibility, FunctionalStrengthTraining, Golf, HighIntensityIntervalTraining, Hiking, MindAndBody, Other, Pickleball, Running, SnowSports, Tennis, TraditionalStrengthTraining, Walking

## Examples

```bash
# Last 7 days of health data
curl -s "http://host.docker.internal:3002/api/health?days=7"

# Specific date range
curl -s "http://host.docker.internal:3002/api/health?since=2026-03-01&until=2026-03-28"

# Last 6 months for trend analysis
curl -s "http://host.docker.internal:3002/api/health?days=180"
```

Parse the JSON response with `node -e` or pipe through shell tools as needed.

## Response Guidance

- Always specify the date range you queried
- Show units (steps, kg/lbs, bpm, km, Cal, hours, minutes)
- For weight, show both kg and lbs
- Round appropriately: steps as integers, weight to 1 decimal, HR as integers
- For trends, mention direction (up/down/stable) and magnitude
- Keep responses concise — Discord messages have a 2000 character limit
- **Reminder: NO markdown tables. Use bullet lists or line-per-item format.**
