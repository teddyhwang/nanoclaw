---
name: health-data
description: Query Apple Health data via the dashboard API. Use when the user asks about steps, weight, heart rate, workouts, sleep, VO2 max, activity rings, or any health/fitness metrics.
allowed-tools: Bash(curl:*), Bash(python3:*)
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

### Quick test

```bash
curl -s "http://host.docker.internal:3002/api/health?days=7" | python3 -c "import sys,json; d=json.load(sys.stdin); print(list(d.keys()))"
```

## Response Shape

The API returns a JSON object with these fields:

```json
{
  "minDate": "2011-01-31",
  "steps": [{ "date": "2026-03-27", "steps": 8432 }, ...],
  "restingHeartRate": [{ "date": "2026-03-27", "value": 52 }, ...],
  "heartRateVariability": [{ "date": "2026-03-27", "value": 45.2 }, ...],
  "weight": [{ "date": "2026-03-27", "value": 82.5 }, ...],
  "bodyFat": [{ "date": "2026-03-27", "value": 18.2 }, ...],
  "activityRings": [{
    "date": "2026-03-27",
    "moveActual": 650,
    "moveGoal": 600,
    "exerciseActual": 35,
    "exerciseGoal": 30,
    "standActual": 12,
    "standGoal": 12
  }, ...],
  "workouts": [{
    "date": "2026-03-27",
    "type": "Running",
    "duration": 32.5,
    "distance": 5.22,
    "calories": 380,
    "avgHR": 143,
    "maxHR": 179
  }, ...],
  "workoutTypeBreakdown": [{
    "type": "Running",
    "count": 12,
    "totalDuration": 384,
    "totalCalories": 4560
  }, ...],
  "weeklyStepAverage": [{
    "week": "2026-03-24",
    "avgSteps": 9143
  }, ...]
}
```

## Common Patterns

### Get health data for a date range

```bash
curl -s "http://host.docker.internal:3002/api/health?days=7" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print('Steps:')
for s in data['steps']:
    print(f\"  {s['date']}: {s['steps']:,}\")
"
```

### Last 30 days of weight

```bash
curl -s "http://host.docker.internal:3002/api/health?days=30" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for w in data['weight']:
    kg = w['value']
    print(f\"{w['date']}: {kg:.1f} kg ({kg * 2.20462:.1f} lbs)\")
"
```

### Recent workouts

```bash
curl -s "http://host.docker.internal:3002/api/health?days=14" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for w in data['workouts']:
    dist = f\"{w['distance']:.1f} km\" if w.get('distance') else ''
    dur = round(w.get('duration', 0))
    print(f\"{w['date']} — {w['type']} — {dur} min {dist} — {w['calories']} Cal\")
"
```

### Activity rings

```bash
curl -s "http://host.docker.internal:3002/api/health?days=7" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for r in data['activityRings']:
    move_pct = round(r['moveActual'] / r['moveGoal'] * 100) if r['moveGoal'] else 0
    ex_pct = round(r['exerciseActual'] / r['exerciseGoal'] * 100) if r['exerciseGoal'] else 0
    stand_pct = round(r['standActual'] / r['standGoal'] * 100) if r['standGoal'] else 0
    print(f\"{r['date']}: Move {move_pct}% | Exercise {ex_pct}% | Stand {stand_pct}%\")
"
```

### Workout breakdown summary

```bash
curl -s "http://host.docker.internal:3002/api/health?days=90" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for b in sorted(data['workoutTypeBreakdown'], key=lambda x: -x['count']):
    print(f\"{b['type']}: {b['count']}x — {round(b['totalDuration'])} min — {b['totalCalories']} Cal\")
"
```

### Complex analysis (trends, averages, comparisons)

For questions that need calculations across the data:

```bash
curl -s "http://host.docker.internal:3002/api/health?days=90" | python3 - <<'PY'
import sys, json

data = json.load(sys.stdin)

# Example: weekly step averages
steps = data['steps']
if steps:
    total = sum(s['steps'] for s in steps)
    avg = total / len(steps)
    best = max(steps, key=lambda s: s['steps'])
    print(f"Daily avg: {avg:,.0f} steps")
    print(f"Best day: {best['date']} — {best['steps']:,} steps")
PY
```

## Response Guidance

- Always specify the date range you queried
- Show units (steps, kg/lbs, bpm, km, Cal, hours, minutes)
- For weight, show both kg and lbs
- Round appropriately: steps as integers, weight to 1 decimal, HR as integers
- For trends, mention direction (up/down/stable) and magnitude
- For sleep, convert fractional hours to hours and minutes (e.g. "7.5 hours" → "7h 30m")
- Keep responses concise — Discord messages have a 2000 character limit
- **Reminder: NO markdown tables. Use bullet lists or line-per-item format.**
