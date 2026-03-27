import { Footprints, Flame, Timer, ArrowUpFromDot, Route, Heart } from 'lucide-react';
import type { HealthData } from '../../types';

interface Props {
  data: HealthData;
}

function RingIndicator({ move, exercise, stand }: { move: number; exercise: number; stand: number }) {
  const size = 64;
  const strokeWidth = 5;
  const rings = [
    { pct: Math.min(move, 1), color: '#f07178', label: 'Move' },
    { pct: Math.min(exercise, 1), color: '#aad94c', label: 'Exercise' },
    { pct: Math.min(stand, 1), color: '#59c2ff', label: 'Stand' },
  ];

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {rings.map((ring, i) => {
        const radius = (size / 2) - strokeWidth * (i + 1) - i * 2;
        const circumference = 2 * Math.PI * radius;
        const offset = circumference * (1 - ring.pct);
        return (
          <g key={ring.label}>
            <circle
              cx={size / 2} cy={size / 2} r={radius}
              fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={strokeWidth}
            />
            <circle
              cx={size / 2} cy={size / 2} r={radius}
              fill="none" stroke={ring.color} strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              style={{ transition: 'stroke-dashoffset 0.6s ease' }}
            />
          </g>
        );
      })}
    </svg>
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function HealthSummary({ data }: Props) {
  const days = data.steps.length || 1;

  // Avg daily steps
  const totalSteps = data.steps.reduce((s, d) => s + d.steps, 0);
  const avgSteps = Math.round(totalSteps / days);

  // Avg daily calories from activity rings (move = active energy burned)
  const totalCal = data.activityRings.reduce((s, d) => s + d.moveActual, 0);
  const avgCal = Math.round(totalCal / (data.activityRings.length || 1));

  // Avg daily exercise minutes
  const totalExercise = data.activityRings.reduce((s, d) => s + d.exerciseActual, 0);
  const avgExercise = Math.round(totalExercise / (data.activityRings.length || 1));

  // Avg daily stand hours
  const totalStand = data.activityRings.reduce((s, d) => s + d.standActual, 0);
  const avgStand = Math.round((totalStand / (data.activityRings.length || 1)) * 10) / 10;

  // Total workouts
  const totalWorkouts = data.workouts.length;

  // Avg resting HR
  const hrValues = data.restingHeartRate;
  const avgHR = hrValues.length > 0
    ? Math.round(hrValues.reduce((s, d) => s + d.value, 0) / hrValues.length)
    : null;

  // Ring closure rate (avg across period)
  const rings = data.activityRings;
  const ringDays = rings.length || 1;
  const avgMovePct = rings.reduce((s, d) => s + d.moveActual / d.moveGoal, 0) / ringDays;
  const avgExercisePct = rings.reduce((s, d) => s + d.exerciseActual / d.exerciseGoal, 0) / ringDays;
  const avgStandPct = rings.reduce((s, d) => s + d.standActual / d.standGoal, 0) / ringDays;

  const stats = [
    { label: 'Avg Steps', value: fmt(avgSteps), icon: Footprints, color: 'var(--green)' },
    { label: 'Avg Cal', value: fmt(avgCal), icon: Flame, color: 'var(--orange)' },
    { label: 'Avg Exercise', value: `${avgExercise} min`, icon: Timer, color: 'var(--yellow)' },
    { label: 'Avg Stand', value: `${avgStand} hrs`, icon: ArrowUpFromDot, color: 'var(--blue)' },
    { label: 'Workouts', value: `${totalWorkouts}`, icon: Route, color: 'var(--cyan)' },
    { label: 'Avg RHR', value: avgHR ? `${avgHR} bpm` : '—', icon: Heart, color: 'var(--red)' },
  ];

  return (
    <div className="health-summary">
      <div className="health-summary-grid">
        <div className="health-stat health-stat-rings">
          <RingIndicator move={avgMovePct} exercise={avgExercisePct} stand={avgStandPct} />
          <div className="ring-labels">
            <span style={{ color: '#f07178' }}>Move {Math.round(avgMovePct * 100)}%</span>
            <span style={{ color: '#aad94c' }}>Exercise {Math.round(avgExercisePct * 100)}%</span>
            <span style={{ color: '#59c2ff' }}>Stand {Math.round(avgStandPct * 100)}%</span>
          </div>
        </div>
        {stats.map((st) => (
          <div key={st.label} className="health-stat">
            <div className="health-stat-icon" style={{ color: st.color }}>
              <st.icon size={16} />
            </div>
            <span className="health-stat-label">{st.label}</span>
            <span className="health-stat-value" style={{ color: st.color }}>{st.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
