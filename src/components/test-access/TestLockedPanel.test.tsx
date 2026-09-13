import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TestLockedPanel } from './TestLockedPanel';

describe('TestLockedPanel', () => {
  it('shows the final lock state with Back to Assignments as the only action', () => {
    const onBack = vi.fn();
    render(<TestLockedPanel onBack={onBack} />);

    expect(screen.getByRole('heading', { name: 'Test Locked' })).toBeInTheDocument();
    expect(screen.getByText(/stopped screen sharing/i)).toBeInTheDocument();
    expect(screen.queryByText(/continue test|resume attempt|restart monitoring|share screen again/i)).not.toBeInTheDocument();
    const actions = screen.getAllByRole('button');
    expect(actions).toHaveLength(1);
    fireEvent.click(actions[0]);
    expect(onBack).toHaveBeenCalledOnce();
  });
});
