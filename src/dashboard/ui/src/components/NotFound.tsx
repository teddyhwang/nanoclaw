import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="error-page">
      <div className="error-page-content">
        <div className="error-code">404</div>
        <h1 className="error-title">Page Not Found</h1>
        <div className="error-divider" />
        <p className="error-message">The page you're looking for doesn't exist.</p>
        <Link to="/" className="error-link">← Back to Dashboard</Link>
      </div>
    </div>
  );
}
