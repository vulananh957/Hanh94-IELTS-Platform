import type { ReactNode } from 'react';
import { AuthRouteGuard } from '@/components/auth-route-guard';

export default function TeacherRouteLayout({ children }: { children: ReactNode }) {
  return <AuthRouteGuard area="teacher">{children}</AuthRouteGuard>;
}
