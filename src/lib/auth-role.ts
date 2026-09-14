export type UserRole = 'teacher' | 'student' | 'testCreator';

export function normalizeRole(value: unknown): UserRole | null {
  const role = String(value ?? '').trim().toLowerCase();
  if (role === 'teacher' || role === 'student') return role;
  if (role === 'testcreator' || role === 'test_creator' || role === 'creator') return 'testCreator';
  return null;
}

export function isDisabledAccount(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  return [data.status, data.accountStatus].some((value) =>
    ['disabled', 'deleted', 'inactive'].includes(String(value ?? '').trim().toLowerCase()),
  ) || data.isActive === false || data.disabled === true || Boolean(data.deletedAt) || Boolean(data.removedAt);
}
