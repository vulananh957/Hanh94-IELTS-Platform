export type UserDirectoryData = Record<string, unknown>;

function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function isManagedUserDisabled(data: UserDirectoryData): boolean {
  const status = text(data.status).toLowerCase();
  return (
    status === 'disabled' ||
    status === 'deleted' ||
    data.isActive === false ||
    data.disabled === true ||
    Boolean(data.deletedAt) ||
    Boolean(data.removedAt)
  );
}

export function managedUserRole(data: UserDirectoryData): string {
  return text(data.role, 'student') || 'student';
}

export function isActiveManagedStudent(data: UserDirectoryData): boolean {
  return managedUserRole(data) === 'student' && !isManagedUserDisabled(data);
}
