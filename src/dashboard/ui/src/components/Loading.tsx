interface LoadingProps {
  message?: string;
  error?: string;
}

export function Loading({ message = 'Loading…', error }: LoadingProps) {
  if (error) {
    return (
      <div className="loading">
        <span style={{ color: 'var(--red)' }}>Error: {error}</span>
      </div>
    );
  }
  return (
    <div className="loading">
      <div className="spinner" />
      <span>{message}</span>
    </div>
  );
}
