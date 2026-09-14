import type { ReactNode } from 'react';
import { AuthRouteGuard } from '@/components/auth-route-guard';

export default function StudentRouteLayout({ children }: { children: ReactNode }) {
  return <AuthRouteGuard area="student">{children}</AuthRouteGuard>;
}
