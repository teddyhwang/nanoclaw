/**
 * Health data module — queries Apple Health export stored in SQLite.
 *
 * Uses better-sqlite3 for fast, synchronous, in-process queries.
 * The health.db dates are stored as 'YYYY-MM-DD HH:MM:SS ±ZZZZ' text —
 * we use string comparison (start_date >= 'YYYY-MM-DD') which hits the
 * idx_records_type_date composite index for sub-millisecond lookups.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.resolve(process.cwd(), 'db', 'health.db');

// ── Types ───────────────────────────────────────────────────

export interface DateValue {
  date: string;
  value: number;
}
export interface StepDay {
  date: string;
  steps: number;
}
export interface SleepNight {
  date: string;
  hours: number;
}

export interface ActivityRingDay {
  date: string;
  moveActual: number;
  moveGoal: number;
  exerciseActual: number;
  exerciseGoal: number;
  standActual: number;
  standGoal: number;
}

export interface WorkoutEntry {
  date: string;
  type: string;
  duration: number;
  distance: number | null;
  calories: number | null;
  avgHR: number | null;
  maxHR: number | null;
}

export interface WorkoutTypeBreakdown {
  type: string;
  count: number;
  totalDuration: number;
  totalCalories: number;
}

export interface WeeklyStepAvg {
  week: string;
  avgSteps: number;
}

export interface HealthData {
  minDate: string;
  steps: StepDay[];
  restingHeartRate: DateValue[];
  heartRateVariability: DateValue[];
  weight: DateValue[];
  bodyFat: DateValue[];
  activityRings: ActivityRingDay[];
  workouts: WorkoutEntry[];
  workoutTypeBreakdown: WorkoutTypeBreakdown[];
  weeklyStepAverage: WeeklyStepAvg[];
}

// ── Database connection (lazy singleton) ────────────────────

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`Health database not found: ${DB_PATH}`);
  }
  _db = new Database(DB_PATH, { readonly: true });
  _db.pragma('mmap_size = 268435456');
  return _db;
}

// ── Date helpers ────────────────────────────────────────────

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function weekStart(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().slice(0, 10);
}

// ── Range type for queries ──────────────────────────────────

/** Internal: resolved date range for all queries */
interface DateRange {
  since: string;
  until: string | null; // null = no upper bound (up to today)
}

function recordWhere(r: DateRange): string {
  if (r.until)
    return `start_date >= '${r.since}' AND start_date < '${r.until}'`;
  return `start_date >= '${r.since}'`;
}

function dateCompWhere(r: DateRange): string {
  if (r.until)
    return `date_components >= '${r.since}' AND date_components < '${r.until}'`;
  return `date_components >= '${r.since}'`;
}

function workoutWhere(r: DateRange): string {
  if (r.until)
    return `w.start_date >= '${r.since}' AND w.start_date < '${r.until}'`;
  return `w.start_date >= '${r.since}'`;
}

// ── Query functions ─────────────────────────────────────────

function getSteps(db: Database.Database, r: DateRange): StepDay[] {
  return db
    .prepare(
      `
    SELECT substr(start_date, 1, 10) AS date, CAST(ROUND(SUM(value)) AS INTEGER) AS steps
    FROM records WHERE type = 'StepCount' AND ${recordWhere(r)}
    GROUP BY substr(start_date, 1, 10) ORDER BY date
  `,
    )
    .all() as StepDay[];
}

function getRestingHeartRate(db: Database.Database, r: DateRange): DateValue[] {
  return db
    .prepare(
      `
    SELECT substr(start_date, 1, 10) AS date, ROUND(AVG(value), 1) AS value
    FROM records WHERE type = 'RestingHeartRate' AND ${recordWhere(r)}
    GROUP BY substr(start_date, 1, 10) ORDER BY date
  `,
    )
    .all() as DateValue[];
}

function getHRV(db: Database.Database, r: DateRange): DateValue[] {
  return db
    .prepare(
      `
    SELECT substr(start_date, 1, 10) AS date, ROUND(AVG(value), 1) AS value
    FROM records WHERE type = 'HeartRateVariabilitySDNN' AND ${recordWhere(r)}
    GROUP BY substr(start_date, 1, 10) ORDER BY date
  `,
    )
    .all() as DateValue[];
}

function getWeight(db: Database.Database, r: DateRange): DateValue[] {
  return db
    .prepare(
      `
    SELECT substr(start_date, 1, 10) AS date, ROUND(value, 1) AS value
    FROM records WHERE type = 'BodyMass' AND ${recordWhere(r)}
    ORDER BY start_date
  `,
    )
    .all() as DateValue[];
}

function getBodyFat(db: Database.Database, r: DateRange): DateValue[] {
  return db
    .prepare(
      `
    SELECT substr(start_date, 1, 10) AS date, ROUND(value * 100, 1) AS value
    FROM records WHERE type = 'BodyFatPercentage' AND ${recordWhere(r)}
    ORDER BY start_date
  `,
    )
    .all() as DateValue[];
}

function getActivityRings(
  db: Database.Database,
  r: DateRange,
): ActivityRingDay[] {
  return db
    .prepare(
      `
    SELECT date_components AS date,
      ROUND(active_energy_burned) AS moveActual, ROUND(active_energy_burned_goal) AS moveGoal,
      ROUND(apple_exercise_time) AS exerciseActual, ROUND(apple_exercise_time_goal) AS exerciseGoal,
      ROUND(apple_stand_hours) AS standActual, ROUND(apple_stand_hours_goal) AS standGoal
    FROM activity_summaries WHERE ${dateCompWhere(r)}
    ORDER BY date_components
  `,
    )
    .all() as ActivityRingDay[];
}

function getWorkouts(db: Database.Database, r: DateRange): WorkoutEntry[] {
  return db
    .prepare(
      `
    SELECT substr(w.start_date, 1, 10) AS date, w.activity_type AS type,
      ROUND(w.duration, 1) AS duration,
      COALESCE(w.total_distance,
        (SELECT ws2.sum FROM workout_statistics ws2 WHERE ws2.workout_id = w.id AND ws2.type = 'DistanceWalkingRunning')) AS distance,
      COALESCE(ROUND(w.total_energy_burned),
        ROUND((SELECT ws3.sum FROM workout_statistics ws3 WHERE ws3.workout_id = w.id AND ws3.type = 'ActiveEnergyBurned'))) AS calories,
      ROUND(hr.average) AS avgHR, ROUND(hr.maximum) AS maxHR
    FROM workouts w
    LEFT JOIN workout_statistics hr ON hr.workout_id = w.id AND hr.type = 'HeartRate'
    WHERE ${workoutWhere(r)}
    ORDER BY w.start_date DESC
  `,
    )
    .all() as WorkoutEntry[];
}

function getWorkoutTypeBreakdown(
  db: Database.Database,
  r: DateRange,
): WorkoutTypeBreakdown[] {
  return db
    .prepare(
      `
    SELECT w.activity_type AS type, COUNT(*) AS count,
      ROUND(SUM(w.duration)) AS totalDuration,
      ROUND(SUM(COALESCE(w.total_energy_burned,
        (SELECT ws.sum FROM workout_statistics ws WHERE ws.workout_id = w.id AND ws.type = 'ActiveEnergyBurned'), 0))) AS totalCalories
    FROM workouts w WHERE ${workoutWhere(r)}
    GROUP BY w.activity_type ORDER BY count DESC
  `,
    )
    .all() as WorkoutTypeBreakdown[];
}

function getWeeklyStepAverage(
  db: Database.Database,
  r: DateRange,
): WeeklyStepAvg[] {
  const daily = db
    .prepare(
      `
    SELECT substr(start_date, 1, 10) AS date, SUM(value) AS steps
    FROM records WHERE type = 'StepCount' AND ${recordWhere(r)}
    GROUP BY substr(start_date, 1, 10) ORDER BY date
  `,
    )
    .all() as { date: string; steps: number }[];

  const weekMap = new Map<string, { total: number; count: number }>();
  for (const d of daily) {
    const wk = weekStart(d.date);
    const entry = weekMap.get(wk);
    if (entry) {
      entry.total += d.steps;
      entry.count++;
    } else {
      weekMap.set(wk, { total: d.steps, count: 1 });
    }
  }

  return Array.from(weekMap.entries())
    .map(([week, { total, count }]) => ({
      week,
      avgSteps: Math.round(total / count),
    }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

// ── Public API ──────────────────────────────────────────────

export interface HealthQueryOptions {
  /** Number of days to look back. Default: 90 */
  days?: number;
  /** Explicit start date (YYYY-MM-DD). Overrides days if set. */
  since?: string;
  /** Explicit end date (YYYY-MM-DD, exclusive). If omitted, no upper bound. */
  until?: string;
}

export function getHealthData(options?: HealthQueryOptions): HealthData {
  const since = options?.since ?? daysAgo(options?.days ?? 90);
  const until = options?.until ?? null;
  const r: DateRange = { since, until };
  const db = getDb();

  // Get the earliest record date (cached after first call)
  const minRow = db
    .prepare(`SELECT MIN(substr(start_date, 1, 10)) AS d FROM records`)
    .get() as { d: string } | undefined;
  const minDate = minRow?.d ?? '2011-01-01';

  return {
    minDate,
    steps: getSteps(db, r),
    restingHeartRate: getRestingHeartRate(db, r),
    heartRateVariability: getHRV(db, r),
    weight: getWeight(db, r),
    bodyFat: getBodyFat(db, r),
    activityRings: getActivityRings(db, r),
    workouts: getWorkouts(db, r),
    workoutTypeBreakdown: getWorkoutTypeBreakdown(db, r),
    weeklyStepAverage: getWeeklyStepAverage(db, r),
  };
}
