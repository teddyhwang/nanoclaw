import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Loading } from './Loading';

describe('Loading', () => {
  it('shows default loading message', () => {
    render(<Loading />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows custom loading message', () => {
    render(<Loading message="Fetching data…" />);
    expect(screen.getByText('Fetching data…')).toBeInTheDocument();
  });

  it('shows error message', () => {
    render(<Loading error="Something went wrong" />);
    expect(screen.getByText('Error: Something went wrong')).toBeInTheDocument();
  });

  it('shows spinner when loading', () => {
    const { container } = render(<Loading />);
    expect(container.querySelector('.spinner')).toBeInTheDocument();
  });

  it('does not show spinner when error', () => {
    const { container } = render(<Loading error="fail" />);
    expect(container.querySelector('.spinner')).not.toBeInTheDocument();
  });
});
