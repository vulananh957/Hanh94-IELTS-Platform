import type { ReactNode } from 'react';
import { AuthRouteGuard } from '@/components/auth-route-guard';

export default function CreatorRouteLayout({ children }: { children: ReactNode }) {
  return <AuthRouteGuard area="creator">{children}</AuthRouteGuard>;
}
